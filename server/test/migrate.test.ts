// Fake client, zero I/O. Proves the three Story 4.6 branches: flat-keys-only
// (RENAME + warn), both namespaced and flat present (DEL flat + warn), and a
// fresh v1.1 install (no flat keys — no-op).
import { describe, expect, it, vi } from "vitest";
import { createFlatKeyMigrator, type MigrateCommands, type MigrateLogger } from "../src/adapters/redis/migrate.ts";
import { stockKeyFor } from "../src/adapters/redis/stock.ts";
import { ordersKeyFor } from "../src/adapters/redis/orders.ts";

const SALE_ID = "sale-abc123";
const SLUG = "flash-sale";
const FLAT_STOCK_KEY = "stock:remaining";
const FLAT_ORDERS_KEY = "orders:users";

function fakeClient(existing: Set<string> = new Set()) {
  const keys = new Set(existing);
  return {
    keys,
    exists: vi.fn<MigrateCommands["exists"]>(async (key: string) => (keys.has(key) ? 1 : 0)),
    rename: vi.fn<MigrateCommands["rename"]>(async (source: string, destination: string) => {
      keys.delete(source);
      keys.add(destination);
      return "OK";
    }),
    del: vi.fn<MigrateCommands["del"]>(async (key: string) => {
      const had = keys.has(key);
      keys.delete(key);
      return had ? 1 : 0;
    }),
  };
}

function fakeLogger() {
  return { warn: vi.fn<MigrateLogger["warn"]>() };
}

const opts = { commandTimeoutMs: 50 };

describe("createFlatKeyMigrator", () => {
  it("AC1: flat keys only — RENAMEs both to their namespaced form and warn-logs the exact migration message", async () => {
    const client = fakeClient(new Set([FLAT_STOCK_KEY, FLAT_ORDERS_KEY]));
    const logger = fakeLogger();

    await createFlatKeyMigrator(client, logger, opts).migrate(SALE_ID, SLUG);

    expect(client.rename).toHaveBeenCalledWith(FLAT_STOCK_KEY, stockKeyFor(SALE_ID));
    expect(client.rename).toHaveBeenCalledWith(FLAT_ORDERS_KEY, ordersKeyFor(SALE_ID));
    expect(client.del).not.toHaveBeenCalled();
    expect(client.keys.has(stockKeyFor(SALE_ID))).toBe(true);
    expect(client.keys.has(ordersKeyFor(SALE_ID))).toBe(true);
    expect(client.keys.has(FLAT_STOCK_KEY)).toBe(false);
    expect(client.keys.has(FLAT_ORDERS_KEY)).toBe(false);

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { saleId: SALE_ID, slug: SLUG },
      `Migrated v1.0 flat Redis keys to namespaced keys for sale ${SLUG}`,
    );
  });

  it("AC1: only the flat stock key survives — RENAMEs just that one", async () => {
    const client = fakeClient(new Set([FLAT_STOCK_KEY]));
    const logger = fakeLogger();

    await createFlatKeyMigrator(client, logger, opts).migrate(SALE_ID, SLUG);

    expect(client.rename).toHaveBeenCalledExactlyOnceWith(FLAT_STOCK_KEY, stockKeyFor(SALE_ID));
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("AC1: both namespaced and flat keys exist — the namespaced keys take precedence; flat keys are DEL'd with a warning", async () => {
    const client = fakeClient(
      new Set([stockKeyFor(SALE_ID), ordersKeyFor(SALE_ID), FLAT_STOCK_KEY, FLAT_ORDERS_KEY]),
    );
    const logger = fakeLogger();

    await createFlatKeyMigrator(client, logger, opts).migrate(SALE_ID, SLUG);

    expect(client.rename).not.toHaveBeenCalled();
    expect(client.del).toHaveBeenCalledWith(FLAT_STOCK_KEY);
    expect(client.del).toHaveBeenCalledWith(FLAT_ORDERS_KEY);
    expect(client.keys.has(stockKeyFor(SALE_ID))).toBe(true);
    expect(client.keys.has(ordersKeyFor(SALE_ID))).toBe(true);
    expect(client.keys.has(FLAT_STOCK_KEY)).toBe(false);
    expect(client.keys.has(FLAT_ORDERS_KEY)).toBe(false);

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { saleId: SALE_ID, slug: SLUG },
      expect.stringContaining("namespaced keys take precedence and the flat keys were deleted"),
    );
  });

  it("AC2: fresh v1.1 install (no flat keys) is a no-op", async () => {
    const client = fakeClient();
    const logger = fakeLogger();

    await createFlatKeyMigrator(client, logger, opts).migrate(SALE_ID, SLUG);

    expect(client.rename).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("a warm namespaced sale with no flat leftovers is a no-op (every boot after the first migration)", async () => {
    const client = fakeClient(new Set([stockKeyFor(SALE_ID), ordersKeyFor(SALE_ID)]));
    const logger = fakeLogger();

    await createFlatKeyMigrator(client, logger, opts).migrate(SALE_ID, SLUG);

    expect(client.rename).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("uses EXISTS guards rather than a try/catch around RENAME — RENAME is never called for an absent flat key", async () => {
    const client = fakeClient(new Set([FLAT_ORDERS_KEY]));
    const logger = fakeLogger();

    await createFlatKeyMigrator(client, logger, opts).migrate(SALE_ID, SLUG);

    expect(client.rename).toHaveBeenCalledExactlyOnceWith(FLAT_ORDERS_KEY, ordersKeyFor(SALE_ID));
    expect(client.rename).not.toHaveBeenCalledWith(FLAT_STOCK_KEY, expect.anything());
  });

  it("a different saleId targets different namespaced keys", async () => {
    const client = fakeClient(new Set([FLAT_STOCK_KEY, FLAT_ORDERS_KEY]));
    const logger = fakeLogger();

    await createFlatKeyMigrator(client, logger, opts).migrate("other-sale", "other-slug");

    expect(client.rename).toHaveBeenCalledWith(FLAT_STOCK_KEY, stockKeyFor("other-sale"));
    expect(client.rename).toHaveBeenCalledWith(FLAT_ORDERS_KEY, ordersKeyFor("other-sale"));
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { saleId: "other-sale", slug: "other-slug" },
      "Migrated v1.0 flat Redis keys to namespaced keys for sale other-slug",
    );
  });
});
