// GET /api/order/:email endpoint tests through the REAL bootstrap() (Story
// 1.5 AC 1-4) — tests never re-implement boot. Same harness as the POST
// tests: shared in-memory fake Redis + fake Mongo model ops, pinned clock,
// silent pino; swap the fake for a real client against compose-run Redis and
// this file runs unchanged (compose validation deferred to Story 3.1 —
// Docker unavailable here).
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { pino } from "pino";
import { bootstrap, type BootstrapOverrides } from "../src/bootstrap.ts";
import { createFakeRedis, type FakeRedis } from "./helpers/fake-redis.ts";
import { createFakeMongo, type FakeMongo } from "./helpers/fake-mongo.ts";

const SALE_START = "2026-07-10T04:00:00Z";
const SALE_END = "2026-07-10T05:00:00Z";
const startMs = Date.parse(SALE_START);
const endMs = Date.parse(SALE_END);
const IN_WINDOW = startMs + 1000;

function overridesFor(fake: FakeRedis, mongo: FakeMongo, nowMs: number): BootstrapOverrides {
  return {
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
}

async function boot(opts: { nowMs: number; stock?: string }) {
  const fake = createFakeRedis(opts.stock === undefined ? {} : { stock: opts.stock });
  const mongo = createFakeMongo();
  const { app } = await bootstrap(overridesFor(fake, mongo, opts.nowMs));
  return { fake, mongo, app };
}

/** Re-boot at another instant against surviving fake state (clock can't move). */
async function rebootAt(fake: FakeRedis, mongo: FakeMongo, nowMs: number) {
  const { app } = await bootstrap(overridesFor(fake, mongo, nowMs));
  return app;
}

const redisCommandCount = (fake: FakeRedis): number =>
  Object.values(fake.calls).reduce((sum, n) => sum + n, 0);

describe("GET /api/order/:email (booted via bootstrap())", () => {
  it("200 ordered:true with the exact body after a 201 order (AC 1)", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    await request(app).post("/api/order").send({ email: "winner@example.com" });

    const res = await request(app).get("/api/order/winner@example.com");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ordered: true, email: "winner@example.com" });
  });

  it("200 ordered:false with the exact body for an email with no order (AC 2)", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    const res = await request(app).get("/api/order/nobody@example.com");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ordered: false, email: "nobody@example.com" });
  });

  it("answers from Redis only — an order that exists ONLY in Mongo reads ordered:false (AC 1, AD-3)", async () => {
    // Warm boot (stock key present) — the AD-4 cold rebuild does NOT run, so
    // Redis never learns about the Mongo-only order below.
    const { fake, mongo, app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    const saleId = mongo.sales.get("flash-sale")?.id;
    expect(saleId).toBeDefined();
    mongo.orders.push({
      id: "order-ghost",
      saleId: saleId as string,
      email: "ghost@example.com",
      userId: "user-ghost",
      status: "confirmed",
    });

    const before = fake.calls;
    const snapshot = { ...before };
    const res = await request(app).get("/api/order/ghost@example.com");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ordered: false, email: "ghost@example.com" });

    // Negative space: exactly one SISMEMBER; the script never runs; no writes.
    expect(fake.calls.sIsMember).toBe(snapshot.sIsMember + 1);
    expect(fake.calls.evalSha).toBe(snapshot.evalSha);
    expect(fake.calls.eval).toBe(snapshot.eval);
    expect(fake.calls.set).toBe(snapshot.set);
    expect(fake.calls.sAdd).toBe(snapshot.sAdd);
    expect(fake.calls.del).toBe(snapshot.del);
  });

  describe("400 validation precedes the Redis read (AC 3) — no Redis command runs", () => {
    const paths: Array<[string, string]> = [
      ["no path param (GET /api/order)", "/api/order"],
      ["trailing slash (GET /api/order/)", "/api/order/"],
      ["whitespace-only param after decode", "/api/order/%20%20"],
      ["257-char email", `/api/order/${"a".repeat(257)}`],
    ];
    for (const [label, path] of paths) {
      it(label, async () => {
        const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
        const baseline = redisCommandCount(fake);
        const res = await request(app).get(path);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ success: false, error: "Email is required." });
        expect(redisCommandCount(fake)).toBe(baseline);
      });
    }

    it("a 256-char email is valid (boundary)", async () => {
      const { app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
      const email = "a".repeat(256);
      const res = await request(app).get(`/api/order/${email}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, ordered: false, email });
    });
  });

  it("trims the path param and echoes the trimmed form", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    await request(app).post("/api/order").send({ email: "padded@example.com" });

    const res = await request(app).get("/api/order/%20padded@example.com%20");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ordered: true, email: "padded@example.com" });
  });

  it("percent-decodes the param (a%2Bb matches the a+b order)", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    await request(app).post("/api/order").send({ email: "a+b@example.com" });

    const res = await request(app).get("/api/order/a%2Bb@example.com");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ordered: true, email: "a+b@example.com" });
  });

  it("answers identically outside the window — never 409, never a window error (AD-2/AD-8)", async () => {
    const { fake, mongo, app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    await request(app).post("/api/order").send({ email: "held@example.com" });

    for (const nowMs of [startMs - 60_000, endMs, endMs + 60_000]) {
      const later = await rebootAt(fake, mongo, nowMs);
      const held = await request(later).get("/api/order/held@example.com");
      expect(held.status).toBe(200);
      expect(held.body).toEqual({ success: true, ordered: true, email: "held@example.com" });

      const unknown = await request(later).get("/api/order/nobody@example.com");
      expect(unknown.status).toBe(200);
      expect(unknown.body).toEqual({ success: true, ordered: false, email: "nobody@example.com" });
    }
  });

  it("fails closed with the exact 503 envelope when Redis is unreachable (AC 4)", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    fake.failing = true;
    const res = await request(app).get("/api/order/who@example.com");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: "Service temporarily unavailable." });
  });
});
