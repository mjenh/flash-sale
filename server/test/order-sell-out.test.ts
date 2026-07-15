// Integration tests for the full order sell-out journey, window boundary
// instants, and the "already-ordered always wins" precedence rule.
//
// Key invariants under test:
//   - Orders are accepted until stock reaches 0; the next request gets 409
//   - "sale.sold_out" is published EXACTLY ONCE — by the request whose Lua
//     script returns OK with remaining === 0. SOLD_OUT verdicts never publish.
//   - The window is [startMs, endMs) — half-open on the right. A request at
//     exactly startMs is inside; at exactly endMs it is outside.
//   - An email that ordered inside the window gets "already ordered" (200)
//     after the window closes — not "inactive" (409).

import { pino } from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { SALE_SLUG } from "../src/adapters/mongo/seed.ts";
import { type BootstrapOverrides, bootstrap } from "../src/bootstrap.ts";
import { createFakeMongo, type FakeMongo, reserveSaleId } from "./helpers/fake-mongo.ts";
import {
  createFakeRedis,
  type FakeRedis,
  orderSetSize,
  stockKeyFor,
} from "./helpers/fake-redis.ts";
import {
  AFTER_END,
  BEFORE_START,
  END_MS,
  IN_WINDOW,
  START_MS,
} from "./helpers/time-fixtures.ts";

/** Drain the microtask / macrotask queues so fire-and-forget side effects
 *  (audit, payment, publish) resolve before we assert on fake state. */
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

async function boot(opts: {
  nowMs: number;
  stock: string;
  redis?: FakeRedis;
  mongo?: FakeMongo;
}) {
  const mongo = opts.mongo ?? createFakeMongo();
  const saleId = await reserveSaleId(mongo, SALE_SLUG);
  const fake =
    opts.redis ??
    createFakeRedis({ stock: opts.stock, saleId });
  const overrides: BootstrapOverrides = {
    env: {},
    logger: pino({ level: "silent" }),
    clock: () => opts.nowMs,
    createRedis: () => fake.client,
    connectRedis: vi.fn(async () => {}),
    disconnectRedis: vi.fn(async () => {}),
    connectMongoDb: vi.fn(async () => {}),
    disconnectMongoDb: vi.fn(async () => {}),
    mongoModelOps: mongo.ops,
  };
  const { app } = await bootstrap(overrides);
  return { app, fake, mongo, saleId };
}

const orderUrl = `/api/sales/${SALE_SLUG}/order`;

// ---------------------------------------------------------------------------
// Full sell-out sequence
// ---------------------------------------------------------------------------

describe("full sell-out sequence", () => {
  it("accepts orders until stock is exhausted, then returns 409 sold out", async () => {
    const { app, fake, saleId } = await boot({ nowMs: IN_WINDOW, stock: "2" });

    const first = await request(app).post(orderUrl).send({ email: "b1@x.com" });
    expect(first.status).toBe(202);
    expect(first.body.message).toBe("Order accepted.");

    const second = await request(app).post(orderUrl).send({ email: "b2@x.com" });
    expect(second.status).toBe(202);
    expect(second.body.message).toBe("Order accepted.");

    // Redis counter must be zero after both orders land.
    expect(fake.kv.get(stockKeyFor(saleId))).toBe("0");

    // Third buyer arrives after stock depletes.
    const third = await request(app).post(orderUrl).send({ email: "b3@x.com" });
    expect(third.status).toBe(409);
    expect(third.body).toEqual({ success: false, error: "Item is sold out." });

    // Counter and membership must not have changed after the 409.
    expect(fake.kv.get(stockKeyFor(saleId))).toBe("0");
    expect(orderSetSize(fake, saleId)).toBe(2);
  });

  it("the GET status endpoint reports sold_out once stock reaches zero", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "1" });

    await request(app).post(orderUrl).send({ email: "b1@x.com" });

    const status = await request(app).get(`/api/sales/${SALE_SLUG}/status`);
    expect(status.status).toBe(200);
    expect(status.body.status).toBe("sold_out");
    expect(status.body.stock).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Event publishing — sold_out is published exactly once
// ---------------------------------------------------------------------------

describe("event publishing during sell-out", () => {
  it("each accepted order publishes order.accepted; the last accepted order also publishes sale.sold_out", async () => {
    const { app, fake } = await boot({ nowMs: IN_WINDOW, stock: "2" });

    await request(app).post(orderUrl).send({ email: "b1@x.com" }); // stock → 1
    await drain();
    expect(fake.published).toEqual(["order.accepted"]);

    await request(app).post(orderUrl).send({ email: "b2@x.com" }); // stock → 0
    await drain();
    expect(fake.published).toEqual(["order.accepted", "order.accepted", "sale.sold_out"]);
  });

  it("a 409 sold-out response publishes no additional events", async () => {
    const { app, fake } = await boot({ nowMs: IN_WINDOW, stock: "1" });

    await request(app).post(orderUrl).send({ email: "b1@x.com" }); // stock → 0, publishes order.accepted + sale.sold_out
    await drain();
    const publishedAfterSellOut = [...fake.published];

    await request(app).post(orderUrl).send({ email: "b2@x.com" }); // 409 SOLD_OUT
    await drain();

    // No new entries were pushed to fake.published.
    expect(fake.published).toEqual(publishedAfterSellOut);
  });

  it("sale.sold_out is published exactly once even when multiple buyers hit the last slot concurrently", async () => {
    // In the real system, the Lua script serialises all slots, so only one
    // request returns OK with remaining === 0. With the in-process fake we can
    // observe the same invariant sequentially: only the stock-depleting OK
    // emits the terminal event.
    const { app, fake } = await boot({ nowMs: IN_WINDOW, stock: "1" });

    await request(app).post(orderUrl).send({ email: "b1@x.com" }); // OK remaining=0
    await request(app).post(orderUrl).send({ email: "b2@x.com" }); // SOLD_OUT
    await request(app).post(orderUrl).send({ email: "b3@x.com" }); // SOLD_OUT
    await drain();

    const soldOutCount = fake.published.filter((e) => e === "sale.sold_out").length;
    expect(soldOutCount).toBe(1);
  });

  it("an idempotent retry (200) publishes no events", async () => {
    const { app, fake } = await boot({ nowMs: IN_WINDOW, stock: "5" });

    await request(app).post(orderUrl).send({ email: "repeat@x.com" });
    await drain();
    const beforeRetry = [...fake.published];

    const retry = await request(app).post(orderUrl).send({ email: "repeat@x.com" });
    expect(retry.status).toBe(200);
    await drain();

    expect(fake.published).toEqual(beforeRetry);
  });
});

// ---------------------------------------------------------------------------
// Window boundary — the half-open [startMs, endMs) invariant
// ---------------------------------------------------------------------------

describe("window boundary exact instants — [start, end) half-open interval", () => {
  it("202 at exactly startMs — the left boundary is inside the window", async () => {
    const { app } = await boot({ nowMs: START_MS, stock: "10" });
    const res = await request(app).post(orderUrl).send({ email: "on-start@x.com" });
    expect(res.status).toBe(202);
    expect(res.body.message).toBe("Order accepted.");
  });

  it("409 inactive at exactly endMs — the right boundary is outside the window", async () => {
    const { app } = await boot({ nowMs: END_MS, stock: "10" });
    const res = await request(app).post(orderUrl).send({ email: "on-end@x.com" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: "Sale is not active." });
  });

  it("409 inactive at startMs - 1 — one millisecond before the window opens", async () => {
    const { app } = await boot({ nowMs: BEFORE_START, stock: "10" });
    const res = await request(app).post(orderUrl).send({ email: "too-early@x.com" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: "Sale is not active." });
  });

  it("409 inactive well after the window closes", async () => {
    const { app } = await boot({ nowMs: AFTER_END, stock: "10" });
    const res = await request(app).post(orderUrl).send({ email: "too-late@x.com" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: "Sale is not active." });
  });
});

// ---------------------------------------------------------------------------
// "Already-ordered always wins" — precedence across window boundary
// The service checks SISMEMBER before the window, so a prior confirmed holder
// always gets 200, never 409 inactive, regardless of when they retry.
// ---------------------------------------------------------------------------

describe("already-ordered precedence across the window boundary", () => {
  it("200 already-ordered when the same email retries after the sale window closes", async () => {
    const mongo = createFakeMongo();
    const saleId = await reserveSaleId(mongo, SALE_SLUG);
    const fake = createFakeRedis({ stock: "5", saleId });

    // First boot: inside the window. Buyer places a successful order.
    const { app: appIn } = await boot({ nowMs: IN_WINDOW, mongo, redis: fake });
    const placed = await request(appIn).post(orderUrl).send({ email: "early-bird@x.com" });
    expect(placed.status).toBe(202);

    // Second boot: after the window, same Redis + Mongo state (warm restart).
    const { app: appOut } = await boot({ nowMs: AFTER_END, mongo, redis: fake });

    const retry = await request(appOut).post(orderUrl).send({ email: "early-bird@x.com" });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({
      success: true,
      email: "early-bird@x.com",
      message: "You have already ordered this item.",
    });
  });

  it("409 inactive for a brand-new email attempting to order after the window closes", async () => {
    const mongo = createFakeMongo();
    const saleId = await reserveSaleId(mongo, SALE_SLUG);
    const fake = createFakeRedis({ stock: "5", saleId });

    await boot({ nowMs: IN_WINDOW, mongo, redis: fake }); // warm up Redis keys

    const { app } = await boot({ nowMs: AFTER_END, mongo, redis: fake });
    const res = await request(app).post(orderUrl).send({ email: "newcomer@x.com" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: "Sale is not active." });
  });

  it("200 already-ordered before the window opens for a buyer that somehow pre-registered", async () => {
    // This exercises the pre-start branch: if an email is already in the Redis
    // set (e.g. from a previous run or a manual seed), hasOrdered returns true
    // and the service returns "already" even outside the window.
    const mongo = createFakeMongo();
    const saleId = await reserveSaleId(mongo, SALE_SLUG);
    const fake = createFakeRedis({ stock: "5", saleId });

    // Place the order in-window first to seed Redis, then query before start.
    const { app: appIn } = await boot({ nowMs: IN_WINDOW, mongo, redis: fake });
    await request(appIn).post(orderUrl).send({ email: "pre-registered@x.com" });

    const { app: appBefore } = await boot({ nowMs: BEFORE_START, mongo, redis: fake });
    const res = await request(appBefore)
      .post(orderUrl)
      .send({ email: "pre-registered@x.com" });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("You have already ordered this item.");
  });
});

// ---------------------------------------------------------------------------
// Stock boundary — stock = 1 is the edge between "active" and "sold_out"
// ---------------------------------------------------------------------------

describe("stock at 1 — last unit edge case", () => {
  it("202 for the buyer who takes the last unit, status then reports sold_out", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "1" });

    const res = await request(app).post(orderUrl).send({ email: "last@x.com" });
    expect(res.status).toBe(202);

    const status = await request(app).get(`/api/sales/${SALE_SLUG}/status`);
    expect(status.body.status).toBe("sold_out");
    expect(status.body.stock).toBe(0);
  });

  it("the buyer that takes the last unit can still look up their order after sell-out", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "1" });
    await request(app).post(orderUrl).send({ email: "last@x.com" });

    const lookup = await request(app).get(`/api/sales/${SALE_SLUG}/order/last@x.com`);
    expect(lookup.status).toBe(200);
    expect(lookup.body).toEqual({ success: true, ordered: true, email: "last@x.com" });
  });
});
