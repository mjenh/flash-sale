// Endpoint tests through the REAL bootstrap() (AC 1, 2, 3, 5) — tests never
// re-implement boot. The Redis client is an injected in-memory fake exposing
// the exact command surface the stock adapter uses (get/setNX); swap it for a
// real client against compose-run Redis and this file runs unchanged
// (compose validation deferred — Docker unavailable in this environment).
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { pino } from "pino";
import { bootstrap, type BootstrapOverrides } from "../src/bootstrap.ts";
import type { RedisClient } from "../src/adapters/redis/client.ts";

const SALE_START = "2026-07-10T04:00:00Z";
const SALE_END = "2026-07-10T05:00:00Z";
const startMs = Date.parse(SALE_START);
const endMs = Date.parse(SALE_END);

interface FakeRedis {
  kv: Map<string, string>;
  failing: boolean;
}

function boot(opts: { nowMs: number; kv?: Map<string, string>; stock?: string }) {
  const fake: FakeRedis = {
    kv: opts.kv ?? new Map(opts.stock === undefined ? [] : [["stock:remaining", opts.stock]]),
    failing: false,
  };
  const client = {
    isOpen: true,
    get: async (key: string) => {
      if (fake.failing) {
        throw new Error("The client is closed");
      }
      return fake.kv.get(key) ?? null;
    },
    setNX: async (key: string, value: string) => {
      if (fake.failing) {
        throw new Error("The client is closed");
      }
      if (fake.kv.has(key)) {
        return 0;
      }
      fake.kv.set(key, value);
      return 1;
    },
  } as unknown as RedisClient;

  const overrides: BootstrapOverrides = {
    env: {
      SALE_START_TIME: SALE_START,
      SALE_END_TIME: SALE_END,
      STOCK_QUANTITY: "100",
    },
    logger: pino({ level: "silent" }),
    clock: () => opts.nowMs,
    createRedis: () => client,
    connectRedis: vi.fn(async () => {}),
    disconnectRedis: vi.fn(async () => {}),
    connectMongoDb: vi.fn(async () => {}),
    disconnectMongoDb: vi.fn(async () => {}),
  };
  return { fake, result: bootstrap(overrides) };
}

describe("GET /api/sale/status (booted via bootstrap())", () => {
  it("cold Redis: boot seeds stock:remaining to STOCK_QUANTITY and reports upcoming (FR-1 body)", async () => {
    const { fake, result } = boot({ nowMs: startMs - 60_000 });
    const { app } = await result;
    expect(fake.kv.get("stock:remaining")).toBe("100");

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
    const { fake, result } = boot({ nowMs: startMs, stock: "37" });
    const { app } = await result;
    expect(fake.kv.get("stock:remaining")).toBe("37");

    const res = await request(app).get("/api/sale/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
    expect(res.body.stock).toBe(37);
  });

  it("reports sold_out inside the window at stock 0", async () => {
    const { result } = boot({ nowMs: startMs + 1000, stock: "0" });
    const { app } = await result;
    const res = await request(app).get("/api/sale/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sold_out");
    expect(res.body.stock).toBe(0);
  });

  it("reports ended at the exact end boundary ([start, end)) even with stock left", async () => {
    const { result } = boot({ nowMs: endMs, stock: "12" });
    const { app } = await result;
    const res = await request(app).get("/api/sale/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ended");
    expect(res.body.stock).toBe(12);
  });

  it("fails closed with the exact 503 envelope when Redis commands fail (AD-5, NFR-9)", async () => {
    const { fake, result } = boot({ nowMs: startMs + 1000, stock: "50" });
    const { app } = await result;
    fake.failing = true;

    const res = await request(app).get("/api/sale/status");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: "Service temporarily unavailable." });
  });
});
