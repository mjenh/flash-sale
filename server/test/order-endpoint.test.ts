// POST /api/order endpoint tests through the REAL bootstrap() (AC 1-7) —
// tests never re-implement boot. The Redis client is the shared in-memory
// fake whose eval executes a faithful, atomic-per-call port of order.lua;
// swap it for a real client against compose-run Redis and this file runs
// unchanged (compose validation deferred — Docker unavailable here; the
// cross-process race guarantee is Redis's single-threaded script execution,
// proven end-to-end by Story 3.1's k6 harness).
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { pino } from "pino";
import { bootstrap, type BootstrapOverrides } from "../src/bootstrap.ts";
import { createFakeRedis, orderSetSize, type FakeRedis } from "./helpers/fake-redis.ts";
import { createFakeMongo } from "./helpers/fake-mongo.ts";

const SALE_START = "2026-07-10T04:00:00Z";
const SALE_END = "2026-07-10T05:00:00Z";
const startMs = Date.parse(SALE_START);
const endMs = Date.parse(SALE_END);
const IN_WINDOW = startMs + 1000;

async function boot(opts: { nowMs: number; stock?: string; stockQuantity?: string }) {
  const fake: FakeRedis = createFakeRedis(opts.stock === undefined ? {} : { stock: opts.stock });
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
    // Story 1.4: boot runs the AD-4 seed + reconcile over the mongo model ops.
    mongoModelOps: createFakeMongo().ops,
  };
  const { app } = await bootstrap(overrides);
  return { fake, app };
}

describe("POST /api/order (booted via bootstrap())", () => {
  it("201 with the exact body for a new email in-window; stock decrements; email joins the set", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "3" });
    const res = await request(app).post("/api/order").send({ email: "buyer@example.com" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      success: true,
      email: "buyer@example.com",
      message: "Order successful.",
    });
    expect(fake.kv.get("stock:remaining")).toBe("2");
    expect(fake.sets.get("orders:users")?.has("buyer@example.com")).toBe(true);
  });

  it("retry -> 200 idempotent body; the confirmed-order count and stock do not change (AC 2)", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "3" });
    await request(app).post("/api/order").send({ email: "buyer@example.com" });

    const retry = await request(app).post("/api/order").send({ email: "buyer@example.com" });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({
      success: true,
      email: "buyer@example.com",
      message: "You have already ordered this item.",
    });
    expect(fake.kv.get("stock:remaining")).toBe("2");
    expect(orderSetSize(fake)).toBe(1);
  });

  it("AI-S1-03: case + whitespace variants of an email are ONE customer; the stored key and echo are canonical", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "3" });

    const first = await request(app).post("/api/order").send({ email: "  Buyer@Example.COM " });
    expect(first.status).toBe(201);
    expect(first.body.email).toBe("buyer@example.com"); // trimmed + case-folded
    expect(fake.sets.get("orders:users")?.has("buyer@example.com")).toBe(true);

    // A different casing is the SAME customer: idempotent 200, no second unit sold.
    const again = await request(app).post("/api/order").send({ email: "BUYER@example.com" });
    expect(again.status).toBe(200);
    expect(fake.kv.get("stock:remaining")).toBe("2"); // only one unit gone
    expect(orderSetSize(fake)).toBe(1);

    // The FR-4 check collapses casing too, so it can't miss the held order.
    const check = await request(app).get("/api/order/Buyer@Example.com");
    expect(check.status).toBe(200);
    expect(check.body).toEqual({ success: true, ordered: true, email: "buyer@example.com" });
  });

  it("409 sold out for a new email at stock 0 inside the window; the set is untouched", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "0" });
    const res = await request(app).post("/api/order").send({ email: "late@example.com" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: "Item is sold out." });
    expect(orderSetSize(fake)).toBe(0);
  });

  it("sold out still yields 200 already for an order holder (AD-2: already outranks stock)", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "1" });
    await request(app).post("/api/order").send({ email: "winner@example.com" });
    expect(fake.kv.get("stock:remaining")).toBe("0");

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

  it("200 already outside the window for an order holder, via SISMEMBER alone (AC 4)", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    await request(app).post("/api/order").send({ email: "held@example.com" });
    const scriptCallsAfterPurchase = fake.calls.evalSha + fake.calls.eval;

    // Same booted app, clock can't move — emulate post-window by booting anew
    // with surviving Redis state (the fake persists across the second boot).
    const after = await bootWithSurvivingState(fake, endMs + 1000);
    const res = await request(after).post("/api/order").send({ email: "held@example.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      email: "held@example.com",
      message: "You have already ordered this item.",
    });
    expect(fake.calls.evalSha + fake.calls.eval).toBe(scriptCallsAfterPurchase); // script did NOT run
  });

  describe("400 validation precedes every other check (AC 5) — no Redis command runs", () => {
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
      expect(res.status).toBe(201);
      expect(res.body.email).toBe(email);
    });
  });

  it("trims the email and uses the trimmed form everywhere", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    const res = await request(app).post("/api/order").send({ email: "  padded@example.com  " });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe("padded@example.com");
    expect(fake.sets.get("orders:users")?.has("padded@example.com")).toBe(true);

    const retry = await request(app).post("/api/order").send({ email: "padded@example.com" });
    expect(retry.status).toBe(200);
  });

  it("fails closed with the exact 503 envelope when Redis commands fail (AC 7)", async () => {
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

  it("survives a script-cache flush mid-run: NOSCRIPT falls back to EVAL transparently (AC 1)", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "2" });
    fake.flushScripts();
    const res = await request(app).post("/api/order").send({ email: "resilient@example.com" });
    expect(res.status).toBe(201);
    expect(res.body.message).toBe("Order successful.");
    expect(fake.calls.eval).toBeGreaterThanOrEqual(1);
  });

  describe("concurrent burst (AC 6 — NFR-1)", () => {
    it("20 unique emails vs stock 5 -> exactly 5x201 + 15x409 sold out; stock 0; set size 5", async () => {
      const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "5", stockQuantity: "5" });
      const emails = Array.from({ length: 20 }, (_, i) => `burst-${i}@example.com`);
      const responses = await Promise.all(
        emails.map((email) => request(app).post("/api/order").send({ email })),
      );

      const created = responses.filter((r) => r.status === 201);
      const soldOut = responses.filter((r) => r.status === 409);
      expect(created).toHaveLength(5);
      expect(soldOut).toHaveLength(15);
      for (const r of soldOut) {
        expect(r.body).toEqual({ success: false, error: "Item is sold out." });
      }
      expect(fake.kv.get("stock:remaining")).toBe("0");
      expect(orderSetSize(fake)).toBe(5);
    });

    it("second mixed burst (5 winners + 15 new) -> 5x200 + 15x409; counts unchanged", async () => {
      const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "5", stockQuantity: "5" });
      const winners = Array.from({ length: 5 }, (_, i) => `w-${i}@example.com`);
      await Promise.all(winners.map((email) => request(app).post("/api/order").send({ email })));
      expect(orderSetSize(fake)).toBe(5);

      const second = await Promise.all(
        [...winners, ...Array.from({ length: 15 }, (_, i) => `n-${i}@example.com`)].map((email) =>
          request(app).post("/api/order").send({ email }),
        ),
      );
      expect(second.filter((r) => r.status === 200)).toHaveLength(5);
      expect(second.filter((r) => r.status === 409)).toHaveLength(15);
      expect(second.filter((r) => r.status === 201)).toHaveLength(0);
      expect(fake.kv.get("stock:remaining")).toBe("0");
      expect(orderSetSize(fake)).toBe(5);
    });

    it("the same email fired concurrently never succeeds twice", async () => {
      const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "10" });
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(app).post("/api/order").send({ email: "dup@example.com" }),
        ),
      );
      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 200)).toHaveLength(9);
      expect(fake.kv.get("stock:remaining")).toBe("9");
      expect(orderSetSize(fake)).toBe(1);
    });
  });
});

async function bootWithSurvivingState(fake: FakeRedis, nowMs: number) {
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
    mongoModelOps: createFakeMongo().ops,
  };
  const { app } = await bootstrap(overrides);
  return app;
}
