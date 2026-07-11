// Unit tests: stock:remaining adapter — bounded commands, SETNX seed,
// fail-closed RedisUnavailableError mapping (AC 3, 4). Fake client, no I/O.
import { describe, expect, it, vi } from "vitest";
import {
  createStockStore,
  RedisUnavailableError,
  type StockCommands,
} from "../src/adapters/redis/stock.ts";

function fakeClient(store: Map<string, string> = new Map()): StockCommands & {
  store: Map<string, string>;
} {
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setNX: vi.fn(async (key: string, value: string) => {
      if (store.has(key)) {
        return 0;
      }
      store.set(key, value);
      return 1;
    }),
  };
}

const opts = { commandTimeoutMs: 50 };

describe("createStockStore", () => {
  it("reads and parses the remaining stock as an integer", async () => {
    const client = fakeClient(new Map([["stock:remaining", "42"]]));
    const stock = createStockStore(client, opts);
    await expect(stock.getRemaining()).resolves.toBe(42);
    expect(client.get).toHaveBeenCalledWith("stock:remaining");
  });

  it("seedIfAbsent writes STOCK_QUANTITY via SETNX when the key is absent", async () => {
    const client = fakeClient();
    const stock = createStockStore(client, opts);
    await stock.seedIfAbsent(100);
    expect(client.setNX).toHaveBeenCalledWith("stock:remaining", "100");
    expect(client.store.get("stock:remaining")).toBe("100");
  });

  it("seedIfAbsent never overwrites surviving state (warm restart no-op)", async () => {
    const client = fakeClient(new Map([["stock:remaining", "7"]]));
    const stock = createStockStore(client, opts);
    await stock.seedIfAbsent(100);
    expect(client.store.get("stock:remaining")).toBe("7");
  });

  it("maps a command rejection (client closed / offline queue) to RedisUnavailableError", async () => {
    const client = fakeClient();
    client.get = vi.fn(async () => {
      throw new Error("The client is closed");
    });
    const stock = createStockStore(client, opts);
    const err = await stock.getRemaining().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedisUnavailableError);
    expect((err as Error).message).toBe("Service temporarily unavailable.");
    expect((err as { status: number }).status).toBe(503);
    expect((err as { expose: boolean }).expose).toBe(true);
  });

  it("treats a hung command as unreachable within the bounded timeout (AD-5)", async () => {
    const client = fakeClient();
    client.get = vi.fn(() => new Promise<string | null>(() => {}));
    const stock = createStockStore(client, { commandTimeoutMs: 10 });
    await expect(stock.getRemaining()).rejects.toBeInstanceOf(RedisUnavailableError);
  });

  it("fails closed when the key is missing mid-run (never fabricates a number)", async () => {
    const client = fakeClient();
    const stock = createStockStore(client, opts);
    await expect(stock.getRemaining()).rejects.toBeInstanceOf(RedisUnavailableError);
  });
});
