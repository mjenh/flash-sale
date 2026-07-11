// Unit tests: boot order + fail-fast (AC 3) with fake connectors — the same
// bootstrap() integration tests will use against compose-run stores (Story 1.2+).
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { pino } from "pino";
import { bootstrap, type BootstrapOverrides } from "../src/bootstrap.ts";
import { ConfigError } from "../src/adapters/config.ts";
import type { RedisClient } from "../src/adapters/redis/client.ts";

const validEnv = {
  SALE_START_TIME: "2026-07-10T04:00:00Z",
  SALE_END_TIME: "2026-07-10T05:00:00Z",
};

function fakeOverrides(env: Record<string, string | undefined>) {
  // In-memory command surface for the stock adapter (get/setNX) + isOpen for teardown.
  const kv = new Map<string, string>();
  const fakeRedis = {
    isOpen: false,
    get: vi.fn(async (key: string) => kv.get(key) ?? null),
    setNX: vi.fn(async (key: string, value: string) => {
      if (kv.has(key)) {
        return 0;
      }
      kv.set(key, value);
      return 1;
    }),
  } as unknown as RedisClient;
  const overrides = {
    env,
    logger: pino({ level: "silent" }),
    createRedis: vi.fn(() => fakeRedis),
    connectRedis: vi.fn(async () => {}),
    disconnectRedis: vi.fn(async () => {}),
    connectMongoDb: vi.fn(async () => {}),
    disconnectMongoDb: vi.fn(async () => {}),
  } satisfies BootstrapOverrides;
  return { fakeRedis, overrides };
}

describe("bootstrap", () => {
  it("fails fast on invalid config before touching any store", async () => {
    const { overrides } = fakeOverrides({});
    await expect(bootstrap(overrides)).rejects.toBeInstanceOf(ConfigError);
    expect(overrides.createRedis).not.toHaveBeenCalled();
    expect(overrides.connectRedis).not.toHaveBeenCalled();
    expect(overrides.connectMongoDb).not.toHaveBeenCalled();
  });

  it("connects Redis before Mongo, then serves the assembled app", async () => {
    const { overrides } = fakeOverrides(validEnv);
    const { app, config } = await bootstrap(overrides);

    expect(overrides.connectRedis).toHaveBeenCalledTimes(1);
    expect(overrides.connectMongoDb).toHaveBeenCalledWith(config.mongodbUri);
    const redisOrder = overrides.connectRedis.mock.invocationCallOrder[0];
    const mongoOrder = overrides.connectMongoDb.mock.invocationCallOrder[0];
    expect(redisOrder).toBeLessThan(mongoOrder as number);

    expect(config.saleStartMs).toBe(Date.parse(validEnv.SALE_START_TIME));
    const res = await request(app).get("/api/anything");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Not found." });
  });

  it("seeds stock:remaining via SETNX during bootstrap — before any listen() (interim AD-4)", async () => {
    const { fakeRedis, overrides } = fakeOverrides(validEnv);
    const setNX = (fakeRedis as unknown as { setNX: ReturnType<typeof vi.fn> }).setNX;
    await bootstrap(overrides);
    expect(setNX).toHaveBeenCalledWith("stock:remaining", "100");
  });

  it("teardown disconnects both stores", async () => {
    const { fakeRedis, overrides } = fakeOverrides(validEnv);
    const { teardown } = await bootstrap(overrides);
    await teardown();
    expect(overrides.disconnectMongoDb).toHaveBeenCalledTimes(1);
    expect(overrides.disconnectRedis).toHaveBeenCalledWith(fakeRedis);
  });
});
