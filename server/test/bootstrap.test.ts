// Boot runs DB reads (listAllSales / selectActiveSale / getSaleProduct) +
// warm/cold reconcile strictly before returning (hence before any listen()).
// It also wires the sale:{saleId}:events realtime layer on a dedicated
// duplicate()d connection (subscribed before returning) with
// future-boundaries-only window timers; teardown closes the subscriber.
//
// Redis keys/channel are namespaced by saleId. fakeOverrides() reserves the
// (idempotent) saleId up front from the fresh fake mongo so tests can
// pre-seed a scoped `stock:{saleId}:remaining` key before bootstrap() runs
// (the warm-boot test) and assert against the exact sale-scoped key/channel
// names elsewhere.
//
// Sale timing and stock come from MongoDB (listAllSales at boot), not from
// env vars. The "fails fast" test uses an invalid PORT to trigger a
// ConfigError from loadConfig rather than missing sale env vars.

import { Writable } from "node:stream";
import { type Logger, pino } from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../src/adapters/config.ts";
import { SALE_SLUG } from "../src/adapters/mongo/seed.ts";
import type { RedisClient } from "../src/adapters/redis/client.ts";
import { SALE_EVENTS_PATTERN } from "../src/adapters/redis/events.ts";
import { ordersKeyFor } from "../src/adapters/redis/orders.ts";
import { stockKeyFor } from "../src/adapters/redis/stock.ts";
import { type BootstrapOverrides, bootstrap } from "../src/bootstrap.ts";
import { createFakeMongo, reserveSaleId } from "./helpers/fake-mongo.ts";
import { END_MS, IN_WINDOW, } from "./helpers/time-fixtures.ts";

const FLAT_STOCK_KEY = "stock:remaining";
const FLAT_ORDERS_KEY = "orders:users";

function captureLogger(): { lines: string[]; logger: Logger } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: pino(stream) };
}

function fakeSubscriber() {
  const subscriber = {
    isOpen: false,
    connect: vi.fn(async () => {
      subscriber.isOpen = true;
    }),
    subscribe: vi.fn(async (_channel: string, _listener: (message: string) => void) => {}),
    unsubscribe: vi.fn(async (_channel: string) => {}),
    // Finding #5: bootstrap now uses pSubscribe(SALE_EVENTS_PATTERN) instead of
    // a saleId-scoped subscribe — the stub must satisfy the updated interface.
    pSubscribe: vi.fn(async (_pattern: string, _listener: (message: string, channel: string) => void) => {}),
    pUnsubscribe: vi.fn(async (_pattern?: string) => {}),
    on: vi.fn((_event: string, _listener: (err: Error) => void) => {}),
    destroy: vi.fn(() => {
      subscriber.isOpen = false;
    }),
    close: vi.fn(async () => {
      subscriber.isOpen = false;
    }),
  };
  return subscriber;
}

async function fakeOverrides(
  env: Record<string, string | undefined>,
  buildInitialKv?: (saleId: string) => Map<string, string>,
  opts?: {
    /** Pre-seed initial Redis SET membership (e.g. a flat `orders:users` set)
     *  keyed by whatever the caller wants — independent of the saleId-keyed
     *  `kv`/string map above. */
    buildInitialSets?: (saleId: string) => Map<string, Set<string>>;
    logger?: Logger;
  },
) {
  // In-memory command surface for the stock adapter (get), the order store's
  // boot-time registration (scriptLoad), the reconciler (exists/del/sAdd/set),
  // the flat-key migrator (exists/rename/del), the sale:{saleId}:events
  // publisher (publish) + the duplicate()d subscriber connection + isOpen for
  // teardown.
  const mongo = createFakeMongo();
  const saleId = await reserveSaleId(mongo, SALE_SLUG);
  const kv = buildInitialKv?.(saleId) ?? new Map<string, string>();
  const sets = opts?.buildInitialSets?.(saleId) ?? new Map<string, Set<string>>();
  const subscriber = fakeSubscriber();
  const fakeRedis = {
    isOpen: false,
    get: vi.fn(async (key: string) => kv.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      kv.set(key, value);
      return "OK";
    }),
    exists: vi.fn(async (key: string) => (kv.has(key) || sets.has(key) ? 1 : 0)),
    del: vi.fn(async (key: string) => {
      kv.delete(key);
      sets.delete(key);
      return 1;
    }),
    rename: vi.fn(async (source: string, destination: string) => {
      if (kv.has(source)) {
        kv.set(destination, kv.get(source) as string);
        kv.delete(source);
      }
      if (sets.has(source)) {
        sets.set(destination, sets.get(source) as Set<string>);
        sets.delete(source);
      }
      return "OK";
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
    publish: vi.fn(async () => 1),
    duplicate: vi.fn(() => subscriber),
  } as unknown as RedisClient;
  const overrides = {
    env,
    logger: opts?.logger ?? pino({ level: "silent" }),
    createRedis: vi.fn(() => fakeRedis),
    connectRedis: vi.fn(async () => {}),
    disconnectRedis: vi.fn(async () => {}),
    connectMongoDb: vi.fn(async () => {}),
    disconnectMongoDb: vi.fn(async () => {}),
    mongoModelOps: mongo.ops,
  } satisfies BootstrapOverrides;
  return { fakeRedis, subscriber, kv, sets, mongo, saleId, overrides };
}

describe("bootstrap", () => {
  it("fails fast on invalid config before touching any store", async () => {
    // Invalid PORT is the reliable trigger for a loadConfig() ConfigError
    // before any connection is attempted.
    const { overrides } = await fakeOverrides({ PORT: "99999" });
    await expect(bootstrap(overrides)).rejects.toBeInstanceOf(ConfigError);
    expect(overrides.createRedis).not.toHaveBeenCalled();
    expect(overrides.connectRedis).not.toHaveBeenCalled();
    expect(overrides.connectMongoDb).not.toHaveBeenCalled();
  });

  it("connects Redis before Mongo, then serves the assembled app", async () => {
    const { overrides } = await fakeOverrides({});
    const { app, config } = await bootstrap({ ...overrides, clock: () => IN_WINDOW });

    expect(overrides.connectRedis).toHaveBeenCalledTimes(1);
    expect(overrides.connectMongoDb).toHaveBeenCalledWith(config.mongodbUri);
    const redisOrder = overrides.connectRedis.mock.invocationCallOrder[0];
    const mongoOrder = overrides.connectMongoDb.mock.invocationCallOrder[0];
    expect(redisOrder).toBeLessThan(mongoOrder as number);

    const res = await request(app).get("/api/anything");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Not found." });
  });

  it("registers the order script (SCRIPT LOAD) during bootstrap — before any listen()", async () => {
    const { fakeRedis, overrides } = await fakeOverrides({});
    const scriptLoad = (fakeRedis as unknown as { scriptLoad: ReturnType<typeof vi.fn> }).scriptLoad;
    await bootstrap({ ...overrides, clock: () => IN_WINDOW });
    expect(scriptLoad).toHaveBeenCalledTimes(1);
    expect(String(scriptLoad.mock.calls[0]?.[0])).toContain("SISMEMBER");
  });

  it("pre-seeded domain docs exist and cold rebuild sets stock:{saleId}:remaining from DB", async () => {
    // Bootstrap reads sale/product data from MongoDB (via reserveSaleId
    // pre-seeding); it does NOT write to Mongo at boot. Cold rebuild then
    // sets Redis stock from activeSale.stockQuantity.
    const { kv, mongo, saleId, overrides } = await fakeOverrides({});
    await bootstrap({ ...overrides, clock: () => IN_WINDOW });

    // reserveSaleId pre-seeds all four collections (one of each).
    expect(mongo.products.size).toBe(1);
    expect(mongo.sales.size).toBe(1);
    expect(mongo.saleProducts.size).toBe(1);
    expect(mongo.inventories.size).toBe(1);
    // The DB sale's stockQuantity is the cold-rebuild source.
    expect([...mongo.sales.values()][0]?.stockQuantity).toBe(100);

    // Cold rebuild: no orders in Mongo → stock:{saleId}:remaining = 100.
    expect(kv.get(stockKeyFor(saleId))).toBe("100");
  });

  it("warm boot: surviving stock:{saleId}:remaining is never touched", async () => {
    const { fakeRedis, kv, saleId, overrides } = await fakeOverrides(
      {},
      (id) => new Map([[stockKeyFor(id), "7"]]),
    );
    await bootstrap({ ...overrides, clock: () => IN_WINDOW });
    expect(kv.get(stockKeyFor(saleId))).toBe("7");
    const spies = fakeRedis as unknown as Record<"set" | "del" | "sAdd", ReturnType<typeof vi.fn>>;
    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.del).not.toHaveBeenCalled();
    expect(spies.sAdd).not.toHaveBeenCalled();
  });

  it("boot order: mongo connect → script registration → DB reads → reconcile, all inside bootstrap()", async () => {
    // The boot sequence performs three DB reads (listAllSales / getSaleProduct
    // / listConfirmedOrderEmails) rather than seeding. Spy on listAllSales as
    // the representative DB-read sentinel for ordering assertions.
    const { fakeRedis, mongo, overrides } = await fakeOverrides({});
    const listAllSales = vi.spyOn(mongo.saleBootstrap, "listAllSales");
    await bootstrap({ ...overrides, clock: () => IN_WINDOW });

    const spies = fakeRedis as unknown as Record<"scriptLoad" | "exists" | "set", ReturnType<typeof vi.fn>>;
    const connectOrder = overrides.connectMongoDb.mock.invocationCallOrder[0];
    const scriptOrder = spies.scriptLoad.mock.invocationCallOrder[0];
    const dbReadOrder = listAllSales.mock.invocationCallOrder[0];
    const sentinelOrder = spies.exists.mock.invocationCallOrder[0];
    const rebuildOrder = spies.set.mock.invocationCallOrder[0];
    expect(connectOrder).toBeLessThan(scriptOrder as number);
    expect(scriptOrder).toBeLessThan(dbReadOrder as number);
    expect(dbReadOrder).toBeLessThan(sentinelOrder as number);
    expect(sentinelOrder).toBeLessThan(rebuildOrder as number);
  });

  it("teardown disconnects both stores", async () => {
    const { fakeRedis, overrides } = await fakeOverrides({});
    const { teardown } = await bootstrap({ ...overrides, clock: () => IN_WINDOW });
    await teardown();
    expect(overrides.disconnectMongoDb).toHaveBeenCalledTimes(1);
    expect(overrides.disconnectRedis).toHaveBeenCalledWith(fakeRedis);
  });

  it("subscribes the duplicated connection via PSUBSCRIBE(sale:*:events) during bootstrap() — error listener before connect", async () => {
    // Finding #5: bootstrap now uses pSubscribe(SALE_EVENTS_PATTERN) so the
    // subscriber receives events from any sale — isolation is at the broadcaster
    // layer. saleEventsChannel is still used for publisher.publish() calls.
    const { fakeRedis, subscriber, overrides } = await fakeOverrides({});
    await bootstrap({ ...overrides, clock: () => IN_WINDOW });

    const duplicate = (fakeRedis as unknown as { duplicate: ReturnType<typeof vi.fn> }).duplicate;
    expect(duplicate).toHaveBeenCalledTimes(1);
    expect(subscriber.connect).toHaveBeenCalledTimes(1);
    expect(subscriber.pSubscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.pSubscribe.mock.calls[0]?.[0]).toBe(SALE_EVENTS_PATTERN);
    // subscribe() is NOT called — only pSubscribe is used now.
    expect(subscriber.subscribe).toHaveBeenCalledTimes(0);

    // The error listener (connection-lost trigger) is wired first.
    const onOrder = subscriber.on.mock.invocationCallOrder[0];
    const connectOrder = subscriber.connect.mock.invocationCallOrder[0];
    expect(subscriber.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(onOrder).toBeLessThan(connectOrder as number);
  });

  it("a subscriber connect failure rejects bootstrap() — fail-fast strictly before listen()", async () => {
    const { subscriber, overrides } = await fakeOverrides({});
    subscriber.connect = vi.fn(async () => {
      throw new Error("subscriber refused");
    }) as typeof subscriber.connect;
    await expect(bootstrap({ ...overrides, clock: () => IN_WINDOW })).rejects.toThrow("Service temporarily unavailable.");
  });

  it("teardown calls pUnsubscribe(SALE_EVENTS_PATTERN) then close() before MongoDB disconnects", async () => {
    // Finding #5: teardown now calls pUnsubscribe(SALE_EVENTS_PATTERN) instead
    // of unsubscribe(saleEventsChannel(saleId)).
    const { subscriber, overrides } = await fakeOverrides({});
    const { teardown } = await bootstrap({ ...overrides, clock: () => IN_WINDOW });
    await teardown();
    expect(subscriber.pUnsubscribe).toHaveBeenCalledExactlyOnceWith(SALE_EVENTS_PATTERN);
    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(0);
    expect(subscriber.close).toHaveBeenCalledTimes(1);
    // Subscriber teardown runs before the store disconnects.
    const closeOrder = subscriber.close.mock.invocationCallOrder[0];
    const mongoOrder = overrides.disconnectMongoDb.mock.invocationCallOrder[0];
    expect(closeOrder).toBeLessThan(mongoOrder as number);
  });

  it("a boot pinned after endMs arms NO boundary timers — zero publishes ever", async () => {
    const { fakeRedis, overrides } = await fakeOverrides({});
    await bootstrap({ ...overrides, clock: () => END_MS + 60_000 });
    // Drain pending microtasks and the macrotask queue without a real wall-clock delay.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const publish = (fakeRedis as unknown as { publish: ReturnType<typeof vi.fn> }).publish;
    expect(publish).not.toHaveBeenCalled();
  });

  // Boot-time active-sale identification is multi-sale-safe.
  describe("multi-sale boot reconciliation", () => {
    it("AC4: fails fast with a ConfigError when two Sale documents have overlapping active windows", async () => {
      // The default flash-sale is seeded with ~1970 timing (ended at nowMs=2026)
      // so it's NOT "currently active". Only sale-a and sale-b overlap at nowMs.
      const { mongo, overrides } = await fakeOverrides({});
      const nowMs = Date.parse("2026-07-10T04:30:00Z");
      // Direct map operations replace mongo.seed.upsertSale — sale IDs are
      // explicit strings so tests can reference them without calling upsert.
      mongo.sales.set("sale-a", {
        id: "sale-a",
        name: "Sale A",
        startTime: new Date("2026-07-10T04:00:00Z"),
        endTime: new Date("2026-07-10T05:00:00Z"),
        stockQuantity: 10,
      });
      mongo.sales.set("sale-b", {
        id: "sale-b",
        name: "Sale B",
        startTime: new Date("2026-07-10T04:15:00Z"),
        endTime: new Date("2026-07-10T05:15:00Z"),
        stockQuantity: 20,
      });

      const err = await bootstrap({ ...overrides, clock: () => nowMs }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toBe(
        "Multiple active sales detected. Only one sale may be active at a time.",
      );
    });

    it("AC3: cold rebuild targets only the currently-active sale's keys — an unrelated, already-ended Sale document is neither read nor written", async () => {
      const { kv, sets, mongo, saleId, overrides } = await fakeOverrides({});
      // Add an ended sale directly to the same fake mongo.
      const oldSaleId = "old-sale";
      mongo.sales.set("old-sale", {
        id: oldSaleId,
        name: "Old Sale",
        startTime: new Date("2020-01-01T00:00:00Z"),
        endTime: new Date("2020-01-02T00:00:00Z"),
        stockQuantity: 10,
      });

      await bootstrap({ ...overrides, clock: () => IN_WINDOW });

      // The active sale (flash-sale, time-fixtures timing) was cold-rebuilt as usual.
      expect(kv.get(stockKeyFor(saleId))).toBe("100");
      // The inactive/unrelated sale's keys were never touched.
      expect(kv.has(stockKeyFor(oldSaleId))).toBe(false);
      expect(sets.has(ordersKeyFor(oldSaleId))).toBe(false);
    });

    it("AC3b: multiple Sale documents but only one currently active — boot succeeds and does not throw", async () => {
      const { mongo, overrides } = await fakeOverrides({});
      // An upcoming sale, far enough out that it doesn't overlap the active window.
      mongo.sales.set("future-sale", {
        id: "future-sale",
        name: "Future Sale",
        startTime: new Date("2030-01-01T00:00:00Z"),
        endTime: new Date("2030-01-02T00:00:00Z"),
        stockQuantity: 10,
      });

      await expect(
        bootstrap({ ...overrides, clock: () => IN_WINDOW }),
      ).resolves.toBeDefined();
    });
  });

  // One-time v1.0 -> v1.1 flat-key migration, wired strictly before the
  // warm/cold reconciliation.
  describe("v1.0 flat-key migration", () => {
    it("AC1: surviving flat keys are RENAMEd onto the namespaced keys, warn-logged, and reconciliation then sees a WARM boot (no cold rebuild)", async () => {
      const { lines, logger } = captureLogger();
      const { fakeRedis, kv, sets, saleId, overrides } = await fakeOverrides(
        {},
        () => new Map([[FLAT_STOCK_KEY, "42"]]),
        { buildInitialSets: () => new Map([[FLAT_ORDERS_KEY, new Set(["a@x.com", "b@x.com"])]]), logger },
      );

      await bootstrap({ ...overrides, clock: () => IN_WINDOW });

      // Renamed onto the namespaced keys, with the migrated VALUE preserved
      // (42, not any DB-sourced stock) — proof reconciliation ran AFTER
      // migration and treated the migrated key as warm.
      expect(kv.get(stockKeyFor(saleId))).toBe("42");
      expect(sets.get(ordersKeyFor(saleId))).toEqual(new Set(["a@x.com", "b@x.com"]));
      expect(kv.has(FLAT_STOCK_KEY)).toBe(false);
      expect(sets.has(FLAT_ORDERS_KEY)).toBe(false);

      // Reconciliation's cold-rebuild writer (SET) was never invoked for the
      // stock key beyond the migrator's own RENAME — no cold-rebuild SET call.
      const setSpy = fakeRedis as unknown as { set: ReturnType<typeof vi.fn> };
      expect(setSpy.set).not.toHaveBeenCalled();

      const warnLine = lines.find((l) => l.includes("Migrated v1.0 flat Redis keys"));
      expect(warnLine).toBeDefined();
      const parsed = JSON.parse(warnLine as string) as { level: number; msg: string; saleId: string; slug: string };
      expect(parsed.level).toBe(40); // pino warn
      expect(parsed.msg).toBe(`Migrated v1.0 flat Redis keys to namespaced keys for sale ${SALE_SLUG}`);
      expect(parsed.saleId).toBe(saleId);
      expect(parsed.slug).toBe(SALE_SLUG);
    });

    it("AC1: both namespaced and flat keys exist — namespaced keys take precedence; flat keys are DEL'd with a warning", async () => {
      const { lines, logger } = captureLogger();
      const { kv, sets, saleId, overrides } = await fakeOverrides(
        {},
        (id) => new Map([[stockKeyFor(id), "77"], [FLAT_STOCK_KEY, "999"]]),
        { buildInitialSets: (id) => new Map([[ordersKeyFor(id), new Set(["already@x.com"])], [FLAT_ORDERS_KEY, new Set(["stale@x.com"])]]), logger },
      );

      await bootstrap({ ...overrides, clock: () => IN_WINDOW });

      // The namespaced key's own value survives untouched (warm boot).
      expect(kv.get(stockKeyFor(saleId))).toBe("77");
      expect(sets.get(ordersKeyFor(saleId))).toEqual(new Set(["already@x.com"]));
      // The flat leftovers were deleted, not merged or renamed over.
      expect(kv.has(FLAT_STOCK_KEY)).toBe(false);
      expect(sets.has(FLAT_ORDERS_KEY)).toBe(false);

      const warnLine = lines.find((l) => l.includes("namespaced keys take precedence"));
      expect(warnLine).toBeDefined();
      const parsed = JSON.parse(warnLine as string) as { level: number };
      expect(parsed.level).toBe(40);
    });

    it("AC2: a fresh v1.1 install (no flat keys anywhere) boots with no migration warning logged", async () => {
      const { lines, logger } = captureLogger();
      const { overrides } = await fakeOverrides({}, undefined, { logger });

      await bootstrap({ ...overrides, clock: () => IN_WINDOW });

      expect(lines.some((l) => l.includes("Migrated v1.0 flat Redis keys"))).toBe(false);
      expect(lines.some((l) => l.includes("namespaced keys take precedence"))).toBe(false);
    });

    it("runs strictly before reconciliation: a cold boot (no namespaced OR flat keys) still cold-rebuilds normally", async () => {
      const { kv, saleId, overrides } = await fakeOverrides({});
      await bootstrap({ ...overrides, clock: () => IN_WINDOW });
      expect(kv.get(stockKeyFor(saleId))).toBe("100");
    });
  });
});
