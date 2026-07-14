// Endpoint tests through the REAL bootstrap() — tests never re-implement
// boot. Redis is the shared in-memory fake and Mongo is the shared model-ops
// fake; swap them for real clients against compose-run stores and this file
// runs unchanged.
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { pino } from "pino";
import { bootstrap, type BootstrapOverrides } from "../src/bootstrap.ts";
import { SALE_SLUG } from "../src/adapters/mongo/seed.ts";
import { createFakeRedis, stockKeyFor, type FakeRedis } from "./helpers/fake-redis.ts";
import { createFakeMongo, reserveSaleId } from "./helpers/fake-mongo.ts";

const SALE_START = "2026-07-10T04:00:00Z";
const SALE_END = "2026-07-10T05:00:00Z";
const startMs = Date.parse(SALE_START);
const endMs = Date.parse(SALE_END);

async function boot(opts: { nowMs: number; stock?: string }) {
  const mongo = createFakeMongo();
  const saleId = await reserveSaleId(mongo, SALE_SLUG);
  const fake: FakeRedis = createFakeRedis(opts.stock === undefined ? {} : { stock: opts.stock, saleId });
  const overrides: BootstrapOverrides = {
    env: {
      SALE_START_TIME: SALE_START,
      SALE_END_TIME: SALE_END,
      STOCK_QUANTITY: "100",
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
  return { fake, saleId, result: bootstrap(overrides) };
}

describe("GET /api/sale/status (booted via bootstrap())", () => {
  it("cold Redis: boot rebuilds stock:{saleId}:remaining to STOCK_QUANTITY and reports upcoming", async () => {
    const { fake, saleId, result } = await boot({ nowMs: startMs - 60_000 });
    const { app } = await result;
    expect(fake.kv.get(stockKeyFor(saleId))).toBe("100");

    const res = await request(app).get("/api/sale/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      status: "upcoming",
      stock: 100,
      startTime: "2026-07-10T04:00:00.000Z",
      endTime: "2026-07-10T05:00:00.000Z",
    });
  });

  it("warm Redis: boot never overwrites surviving state; active inside the window", async () => {
    const { fake, saleId, result } = await boot({ nowMs: startMs, stock: "37" });
    const { app } = await result;
    expect(fake.kv.get(stockKeyFor(saleId))).toBe("37");

    const res = await request(app).get("/api/sale/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
    expect(res.body.stock).toBe(37);
  });

  it("reports sold_out inside the window at stock 0", async () => {
    const { result } = await boot({ nowMs: startMs + 1000, stock: "0" });
    const { app } = await result;
    const res = await request(app).get("/api/sale/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sold_out");
    expect(res.body.stock).toBe(0);
  });

  it("reports ended at the exact end boundary ([start, end)) even with stock left", async () => {
    const { result } = await boot({ nowMs: endMs, stock: "12" });
    const { app } = await result;
    const res = await request(app).get("/api/sale/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ended");
    expect(res.body.stock).toBe(12);
  });

  it("fails closed with the exact 503 envelope when Redis commands fail", async () => {
    const { fake, result } = await boot({ nowMs: startMs + 1000, stock: "50" });
    const { app } = await result;
    fake.failing = true;

    const res = await request(app).get("/api/sale/status");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: "Service temporarily unavailable." });
  });
});
