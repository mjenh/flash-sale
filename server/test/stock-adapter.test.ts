// Bounded reads, fail-closed RedisUnavailableError mapping. Fake client,
// no I/O. Story 4.2: keys are namespaced by saleId.
import { describe, expect, it, vi } from "vitest";
import {
  createStockStore,
  RedisUnavailableError,
  stockKeyFor,
  type StockCommands,
} from "../src/adapters/redis/stock.ts";

const SALE_ID = "sale-abc123";

function fakeClient(store: Map<string, string> = new Map()): StockCommands & {
  store: Map<string, string>;
} {
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  };
}

const opts = { commandTimeoutMs: 50 };

describe("createStockStore", () => {
  it("reads and parses the remaining stock as an integer, keyed by saleId", async () => {
    const client = fakeClient(new Map([[stockKeyFor(SALE_ID), "42"]]));
    const stock = createStockStore(client, opts);
    await expect(stock.getRemaining(SALE_ID)).resolves.toBe(42);
    expect(client.get).toHaveBeenCalledWith(stockKeyFor(SALE_ID));
  });

  it("a different saleId reads a different key", async () => {
    const client = fakeClient(new Map([[stockKeyFor("sale-a"), "10"], [stockKeyFor("sale-b"), "20"]]));
    const stock = createStockStore(client, opts);
    await expect(stock.getRemaining("sale-a")).resolves.toBe(10);
    await expect(stock.getRemaining("sale-b")).resolves.toBe(20);
  });

  it("maps a command rejection (client closed / offline queue) to RedisUnavailableError", async () => {
    const client = fakeClient();
    client.get = vi.fn(async () => {
      throw new Error("The client is closed");
    });
    const stock = createStockStore(client, opts);
    const err = await stock.getRemaining(SALE_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedisUnavailableError);
    expect((err as Error).message).toBe("Service temporarily unavailable.");
    expect((err as { status: number }).status).toBe(503);
    expect((err as { expose: boolean }).expose).toBe(true);
  });

  it("treats a hung command as unreachable within the bounded timeout", async () => {
    const client = fakeClient();
    client.get = vi.fn(() => new Promise<string | null>(() => {}));
    const stock = createStockStore(client, { commandTimeoutMs: 10 });
    await expect(stock.getRemaining(SALE_ID)).rejects.toBeInstanceOf(RedisUnavailableError);
  });

  it("fails closed when the key is missing mid-run (never fabricates a number)", async () => {
    const client = fakeClient();
    const stock = createStockStore(client, opts);
    await expect(stock.getRemaining(SALE_ID)).rejects.toBeInstanceOf(RedisUnavailableError);
  });

  it("fails closed on a non-numeric value (NaN would read as sold_out)", async () => {
    const client = fakeClient(new Map([[stockKeyFor(SALE_ID), "not-a-number"]]));
    const stock = createStockStore(client, opts);
    await expect(stock.getRemaining(SALE_ID)).rejects.toBeInstanceOf(RedisUnavailableError);
  });

  it("fails closed on a partly-numeric value (parseInt would truncate '12x' -> 12)", async () => {
    const client = fakeClient(new Map([[stockKeyFor(SALE_ID), "12x"]]));
    const stock = createStockStore(client, opts);
    await expect(stock.getRemaining(SALE_ID)).rejects.toBeInstanceOf(RedisUnavailableError);
  });
});
