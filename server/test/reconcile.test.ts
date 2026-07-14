// Fake client, zero I/O. Proves the warm/cold sentinel read, the
// DEL -> SADD -> SET rebuild ordering (stock is the sentinel, written
// LAST), the empty-set shortcut, and fail-closed wrapping of
// timeouts/rejections into RedisUnavailableError.
import { describe, expect, it, vi } from "vitest";
import { createReconciler, type ReconcileCommands } from "../src/adapters/redis/reconcile.ts";
import { RedisUnavailableError } from "../src/adapters/redis/stock.ts";

function fakeClient() {
  return {
    exists: vi.fn<ReconcileCommands["exists"]>(async () => 0),
    del: vi.fn<ReconcileCommands["del"]>(async () => 1),
    sAdd: vi.fn<ReconcileCommands["sAdd"]>(async () => 1),
    set: vi.fn<ReconcileCommands["set"]>(async () => "OK"),
  };
}

const opts = { commandTimeoutMs: 50 };

describe("createReconciler (restart safety)", () => {
  it("hasStockKey: EXISTS stock:remaining, truthy-coerced", async () => {
    const cold = fakeClient();
    await expect(createReconciler(cold, opts).hasStockKey()).resolves.toBe(false);
    expect(cold.exists).toHaveBeenCalledExactlyOnceWith("stock:remaining");

    const warm = fakeClient();
    warm.exists.mockResolvedValue(1);
    await expect(createReconciler(warm, opts).hasStockKey()).resolves.toBe(true);
  });

  it("rebuild issues DEL orders:users -> SADD members -> SET stock:remaining, in that order", async () => {
    const client = fakeClient();
    await createReconciler(client, opts).rebuild(["a@x.com", "b@x.com"], 98);

    expect(client.del).toHaveBeenCalledExactlyOnceWith("orders:users");
    expect(client.sAdd).toHaveBeenCalledExactlyOnceWith("orders:users", ["a@x.com", "b@x.com"]);
    expect(client.set).toHaveBeenCalledExactlyOnceWith("stock:remaining", "98");

    const [delOrder] = client.del.mock.invocationCallOrder;
    const [sAddOrder] = client.sAdd.mock.invocationCallOrder;
    const [setOrder] = client.set.mock.invocationCallOrder;
    expect(delOrder).toBeLessThan(sAddOrder as number);
    // The stock sentinel is written LAST: a crash mid-rebuild leaves it
    // absent, so the next boot re-runs the cold path idempotently.
    expect(sAddOrder).toBeLessThan(setOrder as number);
  });

  it("rebuild with zero orders skips SADD but still clears the set and writes stock", async () => {
    const client = fakeClient();
    await createReconciler(client, opts).rebuild([], 100);
    expect(client.del).toHaveBeenCalledExactlyOnceWith("orders:users");
    expect(client.sAdd).not.toHaveBeenCalled();
    expect(client.set).toHaveBeenCalledExactlyOnceWith("stock:remaining", "100");
  });

  it("a command rejection wraps into RedisUnavailableError (boot fails fast)", async () => {
    const client = fakeClient();
    client.del.mockRejectedValue(new Error("The client is closed"));
    const err = await createReconciler(client, opts)
      .rebuild(["a@x.com"], 99)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedisUnavailableError);
    expect((err as { status: number }).status).toBe(503);
    expect(client.set).not.toHaveBeenCalled();
  });

  it("a hung command is treated as unreachable within the bounded timeout", async () => {
    const client = fakeClient();
    client.exists.mockImplementation(() => new Promise<never>(() => {}));
    await expect(
      createReconciler(client, { commandTimeoutMs: 10 }).hasStockKey(),
    ).rejects.toBeInstanceOf(RedisUnavailableError);
  });
});
