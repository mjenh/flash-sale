// Endpoint tests through the REAL bootstrap() — tests never re-implement
// boot. The Redis client is the shared in-memory fake whose eval executes a
// faithful, atomic-per-call port of order.lua; swap it for a real client
// against compose-run Redis and this file runs unchanged.
//
// Story 4.2: Redis keys are namespaced by saleId (the resolved Sale's Mongo
// ObjectId string). reserveSaleId() learns the boot-time id up front so the
// fake Redis can be pre-seeded with the correctly scoped `stock:{saleId}:
// remaining` key before bootstrap() runs (see helpers/fake-mongo.ts).
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { pino } from "pino";
import { bootstrap, type BootstrapOverrides } from "../src/bootstrap.ts";
import { SALE_SLUG } from "../src/adapters/mongo/seed.ts";
import { createFakeRedis, orderSetSize, stockKeyFor, ordersKeyFor, type FakeRedis } from "./helpers/fake-redis.ts";
import { createFakeMongo, reserveSaleId, type FakeMongo } from "./helpers/fake-mongo.ts";
import { START_MS, END_MS, IN_WINDOW, START_ISO, END_ISO } from "./helpers/time-fixtures.ts";

const SALE_START = START_ISO;
const SALE_END = END_ISO;
const startMs = START_MS;
const endMs = END_MS;

async function boot(opts: { nowMs: number; stock?: string; stockQuantity?: string }) {
  const mongo = createFakeMongo();
  const saleId = await reserveSaleId(mongo, SALE_SLUG);
  const fake: FakeRedis = createFakeRedis(opts.stock === undefined ? {} : { stock: opts.stock, saleId });
  const overrides: BootstrapOverrides = {
    env: {
      SALE_START_TIME: SALE_START,
      SALE_END_TIME: SALE_END,
      STOCK_QUANTITY: opts.stockQuantity ?? "100",
    },
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
  return { fake, mongo, saleId, app };
}

describe("POST /api/order (booted via bootstrap())", () => {
  it("202 with the exact body for a new email in-window; stock decrements; email joins the set", async () => {
    const { fake, saleId, app } = await boot({ nowMs: IN_WINDOW, stock: "3" });
    const res = await request(app).post("/api/order").send({ email: "buyer@example.com" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      success: true,
      email: "buyer@example.com",
      message: "Order accepted.",
    });
    expect(fake.kv.get(stockKeyFor(saleId))).toBe("2");
    expect(fake.sets.get(ordersKeyFor(saleId))?.has("buyer@example.com")).toBe(true);
  });

  it("retry -> 200 idempotent body; the confirmed-order count and stock do not change", async () => {
    const { fake, saleId, app } = await boot({ nowMs: IN_WINDOW, stock: "3" });
    await request(app).post("/api/order").send({ email: "buyer@example.com" });

    const retry = await request(app).post("/api/order").send({ email: "buyer@example.com" });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({
      success: true,
      email: "buyer@example.com",
      message: "You have already ordered this item.",
    });
    expect(fake.kv.get(stockKeyFor(saleId))).toBe("2");
    expect(orderSetSize(fake, saleId)).toBe(1);
  });

  it("case + whitespace variants of an email are ONE customer; the stored key and echo are canonical", async () => {
    const { fake, saleId, app } = await boot({ nowMs: IN_WINDOW, stock: "3" });

    const first = await request(app).post("/api/order").send({ email: "  Buyer@Example.COM " });
    expect(first.status).toBe(202);
    expect(first.body.email).toBe("buyer@example.com"); // trimmed + case-folded
    expect(fake.sets.get(ordersKeyFor(saleId))?.has("buyer@example.com")).toBe(true);

    // A different casing is the SAME customer: idempotent 200, no second unit sold.
    const again = await request(app).post("/api/order").send({ email: "BUYER@example.com" });
    expect(again.status).toBe(200);
    expect(fake.kv.get(stockKeyFor(saleId))).toBe("2"); // only one unit gone
    expect(orderSetSize(fake, saleId)).toBe(1);

    // The order check collapses casing too, so it can't miss the held order.
    const check = await request(app).get("/api/order/Buyer@Example.com");
    expect(check.status).toBe(200);
    expect(check.body).toEqual({ success: true, ordered: true, email: "buyer@example.com" });
  });

  it("409 sold out for a new email at stock 0 inside the window; the set is untouched", async () => {
    const { fake, saleId, app } = await boot({ nowMs: IN_WINDOW, stock: "0" });
    const res = await request(app).post("/api/order").send({ email: "late@example.com" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: "Item is sold out." });
    expect(orderSetSize(fake, saleId)).toBe(0);
  });

  it("sold out still yields 200 already for an order holder (already outranks stock)", async () => {
    const { fake, saleId, app } = await boot({ nowMs: IN_WINDOW, stock: "1" });
    await request(app).post("/api/order").send({ email: "winner@example.com" });
    expect(fake.kv.get(stockKeyFor(saleId))).toBe("0");

    const res = await request(app).post("/api/order").send({ email: "winner@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("You have already ordered this item.");
  });

  for (const [label, nowMs] of [
    ["before start", startMs - 1],
    ["exactly at end (boundary)", endMs],
    ["after end", endMs + 60_000],
  ] as Array<[string, number]>) {
    it(`409 inactive ${label} with no prior order — and the script never runs`, async () => {
      const { fake, app } = await boot({ nowMs, stock: "50" });
      const res = await request(app).post("/api/order").send({ email: "early@example.com" });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ success: false, error: "Sale is not active." });
      expect(fake.calls.evalSha + fake.calls.eval).toBe(0);
      expect(fake.calls.sIsMember).toBe(1);
    });
  }

  it("200 already outside the window for an order holder, via SISMEMBER alone", async () => {
    const { fake, mongo, app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    await request(app).post("/api/order").send({ email: "held@example.com" });
    const scriptCallsAfterPurchase = fake.calls.evalSha + fake.calls.eval;

    // Same booted app, clock can't move — emulate post-window by booting anew
    // with surviving Redis + Mongo state (both fakes persist across the
    // second boot; reusing the same mongo keeps the saleId — and therefore
    // the sale-scoped Redis keys — identical across both boots).
    const { app: afterApp, teardown } = await bootWithSurvivingState(fake, mongo, endMs + 1000);
    try {
      const res = await request(afterApp).post("/api/order").send({ email: "held@example.com" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        email: "held@example.com",
        message: "You have already ordered this item.",
      });
      expect(fake.calls.evalSha + fake.calls.eval).toBe(scriptCallsAfterPurchase); // script did NOT run
    } finally {
      await teardown();
    }
  });

  describe("400 validation precedes every other check — no Redis command runs", () => {
    const cases: Array<[string, object | string | undefined]> = [
      ["missing body", undefined],
      ["missing email", {}],
      ["non-string email", { email: 42 }],
      ["empty email", { email: "" }],
      ["whitespace-only email", { email: "   " }],
      ["257-char email", { email: "a".repeat(257) }],
    ];
    for (const [label, body] of cases) {
      it(label, async () => {
        const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
        const baseline = fake.calls.evalSha + fake.calls.eval + fake.calls.sIsMember;
        const req = request(app).post("/api/order");
        const res = body === undefined ? await req : await req.send(body);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ success: false, error: "Email is required." });
        expect(fake.calls.evalSha + fake.calls.eval + fake.calls.sIsMember).toBe(baseline);
      });
    }

    it("a 256-char email is valid (boundary)", async () => {
      const { app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
      const email = "a".repeat(256);
      const res = await request(app).post("/api/order").send({ email });
      expect(res.status).toBe(202);
      expect(res.body.email).toBe(email);
    });
  });

  it("trims the email and uses the trimmed form everywhere", async () => {
    const { fake, saleId, app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    const res = await request(app).post("/api/order").send({ email: "  padded@example.com  " });
    expect(res.status).toBe(202);
    expect(res.body.email).toBe("padded@example.com");
    expect(fake.sets.get(ordersKeyFor(saleId))?.has("padded@example.com")).toBe(true);

    const retry = await request(app).post("/api/order").send({ email: "padded@example.com" });
    expect(retry.status).toBe(200);
  });

  it("fails closed with the exact 503 envelope when Redis commands fail", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    fake.failing = true;
    const res = await request(app).post("/api/order").send({ email: "who@example.com" });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: "Service temporarily unavailable." });
  });

  it("503 outside the window too when the SISMEMBER probe fails (fail closed, never guess)", async () => {
    const { fake, app } = await boot({ nowMs: startMs - 1000, stock: "5" });
    fake.failing = true;
    const res = await request(app).post("/api/order").send({ email: "who@example.com" });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: "Service temporarily unavailable." });
  });

  it("survives a script-cache flush mid-run: NOSCRIPT falls back to EVAL transparently", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "2" });
    fake.flushScripts();
    const res = await request(app).post("/api/order").send({ email: "resilient@example.com" });
    expect(res.status).toBe(202);
    expect(res.body.message).toBe("Order accepted.");
    expect(fake.calls.eval).toBeGreaterThanOrEqual(1);
  });

  describe("concurrent burst", () => {
    it("20 unique emails vs stock 5 -> exactly 5x202 + 15x409 sold out; stock 0; set size 5", async () => {
      const { fake, saleId, app } = await boot({ nowMs: IN_WINDOW, stock: "5", stockQuantity: "5" });
      const emails = Array.from({ length: 20 }, (_, i) => `burst-${i}@example.com`);
      const responses = await Promise.all(
        emails.map((email) => request(app).post("/api/order").send({ email })),
      );

      const created = responses.filter((r) => r.status === 202);
      const soldOut = responses.filter((r) => r.status === 409);
      expect(created).toHaveLength(5);
      expect(soldOut).toHaveLength(15);
      for (const r of soldOut) {
        expect(r.body).toEqual({ success: false, error: "Item is sold out." });
      }
      expect(fake.kv.get(stockKeyFor(saleId))).toBe("0");
      expect(orderSetSize(fake, saleId)).toBe(5);
    });

    it("second mixed burst (5 winners + 15 new) -> 5x200 + 15x409; counts unchanged", async () => {
      const { fake, saleId, app } = await boot({ nowMs: IN_WINDOW, stock: "5", stockQuantity: "5" });
      const winners = Array.from({ length: 5 }, (_, i) => `w-${i}@example.com`);
      await Promise.all(winners.map((email) => request(app).post("/api/order").send({ email })));
      expect(orderSetSize(fake, saleId)).toBe(5);

      const second = await Promise.all(
        [...winners, ...Array.from({ length: 15 }, (_, i) => `n-${i}@example.com`)].map((email) =>
          request(app).post("/api/order").send({ email }),
        ),
      );
      expect(second.filter((r) => r.status === 200)).toHaveLength(5);
      expect(second.filter((r) => r.status === 409)).toHaveLength(15);
      expect(second.filter((r) => r.status === 202)).toHaveLength(0);
      expect(fake.kv.get(stockKeyFor(saleId))).toBe("0");
      expect(orderSetSize(fake, saleId)).toBe(5);
    });

    it("the same email fired concurrently never succeeds twice", async () => {
      const { fake, saleId, app } = await boot({ nowMs: IN_WINDOW, stock: "10" });
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(app).post("/api/order").send({ email: "dup@example.com" }),
        ),
      );
      expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 200)).toHaveLength(9);
      expect(fake.kv.get(stockKeyFor(saleId))).toBe("9");
      expect(orderSetSize(fake, saleId)).toBe(1);
    });
  });
});

async function bootWithSurvivingState(fake: FakeRedis, mongo: FakeMongo, nowMs: number) {
  const overrides: BootstrapOverrides = {
    env: {
      SALE_START_TIME: SALE_START,
      SALE_END_TIME: SALE_END,
      STOCK_QUANTITY: "100",
    },
    logger: pino({ level: "silent" }),
    clock: () => nowMs,
    createRedis: () => fake.client,
    connectRedis: vi.fn(async () => {}),
    disconnectRedis: vi.fn(async () => {}),
    connectMongoDb: vi.fn(async () => {}),
    disconnectMongoDb: vi.fn(async () => {}),
    mongoModelOps: mongo.ops,
  };
  const { app, teardown } = await bootstrap(overrides);
  return { app, teardown };
}
