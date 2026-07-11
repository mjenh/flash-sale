// Unit tests: boot order + fail-fast with fake connectors — the same
// bootstrap() integration tests use against compose-run stores (Story 1.2+).
// Story 1.4: boot now runs the AD-4 seed upserts + warm/cold reconcile
// strictly before returning (hence before any listen()).
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { pino } from "pino";
import { bootstrap, type BootstrapOverrides } from "../src/bootstrap.ts";
import { ConfigError } from "../src/adapters/config.ts";
import type { RedisClient } from "../src/adapters/redis/client.ts";
import { createFakeMongo } from "./helpers/fake-mongo.ts";

const validEnv = {
  SALE_START_TIME: "2026-07-10T04:00:00Z",
  SALE_END_TIME: "2026-07-10T05:00:00Z",
};

function fakeOverrides(env: Record<string, string | undefined>, initialKv?: Map<string, string>) {
  // In-memory command surface for the stock adapter (get), the order store's
  // boot-time registration (scriptLoad), the AD-4 reconciler (exists/del/
  // sAdd/set) + isOpen for teardown.
  const kv = initialKv ?? new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const fakeRedis = {
    isOpen: false,
    get: vi.fn(async (key: string) => kv.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      kv.set(key, value);
      return "OK";
    }),
    exists: vi.fn(async (key: string) => (kv.has(key) ? 1 : 0)),
    del: vi.fn(async (key: string) => {
      kv.delete(key);
      sets.delete(key);
      return 1;
    }),
    sAdd: vi.fn(async (key: string, members: string[]) => {
      const set = sets.get(key) ?? new Set<string>();
      for (const member of members) {
        set.add(member);
      }
      sets.set(key, set);
      return members.length;
    }),
    scriptLoad: vi.fn(async () => "fake-sha"),
  } as unknown as RedisClient;
  const mongo = createFakeMongo();
  const overrides = {
    env,
    logger: pino({ level: "silent" }),
    createRedis: vi.fn(() => fakeRedis),
    connectRedis: vi.fn(async () => {}),
    disconnectRedis: vi.fn(async () => {}),
    connectMongoDb: vi.fn(async () => {}),
    disconnectMongoDb: vi.fn(async () => {}),
    mongoModelOps: mongo.ops,
  } satisfies BootstrapOverrides;
  return { fakeRedis, kv, sets, mongo, overrides };
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

  it("registers the AD-1 order script (SCRIPT LOAD) during bootstrap — before any listen()", async () => {
    const { fakeRedis, overrides } = fakeOverrides(validEnv);
    const scriptLoad = (fakeRedis as unknown as { scriptLoad: ReturnType<typeof vi.fn> }).scriptLoad;
    await bootstrap(overrides);
    expect(scriptLoad).toHaveBeenCalledTimes(1);
    expect(String(scriptLoad.mock.calls[0]?.[0])).toContain("SISMEMBER");
  });

  it("cold boot: seeds the four domain docs and rebuilds stock:remaining during bootstrap (AD-4)", async () => {
    const { kv, mongo, overrides } = fakeOverrides(validEnv);
    await bootstrap(overrides);

    // Seed upserts (Product, Sale, SaleProduct, Inventory) from env config.
    expect(mongo.products.size).toBe(1);
    expect(mongo.sales.size).toBe(1);
    expect(mongo.saleProducts.size).toBe(1);
    expect(mongo.inventories.size).toBe(1);
    expect([...mongo.sales.values()][0]?.stockQuantity).toBe(100);

    // Cold rebuild: no orders in Mongo -> stock:remaining = STOCK_QUANTITY.
    expect(kv.get("stock:remaining")).toBe("100");
  });

  it("warm boot: surviving stock:remaining is never touched (STOCK_QUANTITY change is a no-op)", async () => {
    const { fakeRedis, kv, overrides } = fakeOverrides(
      { ...validEnv, STOCK_QUANTITY: "500" },
      new Map([["stock:remaining", "7"]]),
    );
    await bootstrap(overrides);
    expect(kv.get("stock:remaining")).toBe("7");
    const spies = fakeRedis as unknown as Record<"set" | "del" | "sAdd", ReturnType<typeof vi.fn>>;
    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.del).not.toHaveBeenCalled();
    expect(spies.sAdd).not.toHaveBeenCalled();
  });

  it("boot order: mongo connect -> script registration -> seed -> reconcile, all inside bootstrap()", async () => {
    const { fakeRedis, mongo, overrides } = fakeOverrides(validEnv);
    const upsertProduct = vi.fn(mongo.seed.upsertProduct);
    mongo.seed.upsertProduct = upsertProduct;
    await bootstrap(overrides);

    const spies = fakeRedis as unknown as Record<"scriptLoad" | "exists" | "set", ReturnType<typeof vi.fn>>;
    const connectOrder = overrides.connectMongoDb.mock.invocationCallOrder[0];
    const scriptOrder = spies.scriptLoad.mock.invocationCallOrder[0];
    const seedOrder = upsertProduct.mock.invocationCallOrder[0];
    const sentinelOrder = spies.exists.mock.invocationCallOrder[0];
    const rebuildOrder = spies.set.mock.invocationCallOrder[0];
    expect(connectOrder).toBeLessThan(scriptOrder as number);
    expect(scriptOrder).toBeLessThan(seedOrder as number);
    expect(seedOrder).toBeLessThan(sentinelOrder as number);
    expect(sentinelOrder).toBeLessThan(rebuildOrder as number);
  });

  it("teardown disconnects both stores", async () => {
    const { fakeRedis, overrides } = fakeOverrides(validEnv);
    const { teardown } = await bootstrap(overrides);
    await teardown();
    expect(overrides.disconnectMongoDb).toHaveBeenCalledTimes(1);
    expect(overrides.disconnectRedis).toHaveBeenCalledWith(fakeRedis);
  });
});
