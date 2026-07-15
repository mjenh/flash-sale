// Fake client, zero I/O. Covers: registration + sha cache, EVALSHA
// invocation shape, automatic NOSCRIPT -> EVAL fallback, defensive reply
// parsing, bounded timeouts and fail-closed wrapping, and the
// outside-window SISMEMBER probe.
//
// KEYS[1] = stock:{saleId}:remaining, KEYS[2] = orders:{saleId}:users,
// ARGV[1] = email — passed via KEYS[] for Redis Cluster hash-slot routing.
import { describe, expect, it, vi } from "vitest";
import {
  createOrderStore,
  ordersKeyFor,
  ORDER_SCRIPT_SOURCE,
  type OrderCommands,
} from "../src/adapters/redis/orders.ts";
import { RedisUnavailableError, stockKeyFor } from "../src/adapters/redis/stock.ts";

const OPTS = { commandTimeoutMs: 50 };
const SALE_ID = "sale-abc123";

function fakeClient(overrides: Partial<OrderCommands> = {}): OrderCommands {
  return {
    scriptLoad: vi.fn(async () => "sha-1"),
    evalSha: vi.fn(async () => ["OK", 41]),
    eval: vi.fn(async () => ["OK", 41]),
    sIsMember: vi.fn(async () => 0),
    ...overrides,
  };
}

describe("createOrderStore", () => {
  it("register() loads the authoritative .lua source and caches the sha for attempt()", async () => {
    const client = fakeClient();
    const store = createOrderStore(client, OPTS);
    await store.register();
    expect(client.scriptLoad).toHaveBeenCalledWith(ORDER_SCRIPT_SOURCE);

    await store.attempt(SALE_ID, "a@example.com");
    expect(client.evalSha).toHaveBeenCalledWith("sha-1", {
      keys: [stockKeyFor(SALE_ID), ordersKeyFor(SALE_ID)],
      arguments: ["a@example.com"],
    });
    expect(client.eval).not.toHaveBeenCalled();
  });

  it("parses all three verdicts with remaining as a number (string or numeric reply)", async () => {
    const replies: unknown[] = [
      ["OK", 99],
      ["ALREADY", "37"],
      ["SOLD_OUT", 0],
    ];
    const client = fakeClient({ evalSha: vi.fn(async () => replies.shift()) });
    const store = createOrderStore(client, OPTS);
    await store.register();

    expect(await store.attempt(SALE_ID, "a@x.com")).toEqual({ verdict: "OK", remaining: 99 });
    expect(await store.attempt(SALE_ID, "b@x.com")).toEqual({ verdict: "ALREADY", remaining: 37 });
    expect(await store.attempt(SALE_ID, "c@x.com")).toEqual({ verdict: "SOLD_OUT", remaining: 0 });
  });

  it("falls back to EVAL with the source on NOSCRIPT, returns the decision, and re-caches", async () => {
    let scriptCacheFlushed = true;
    const client = fakeClient({
      evalSha: vi.fn(async () => {
        if (scriptCacheFlushed) {
          throw new Error("NOSCRIPT No matching script. Please use EVAL.");
        }
        return ["ALREADY", 12];
      }),
      eval: vi.fn(async () => ["OK", 7]),
      scriptLoad: vi.fn(async () => {
        scriptCacheFlushed = false;
        return "sha-1";
      }),
    });
    const store = createOrderStore(client, OPTS);
    await store.register();
    scriptCacheFlushed = true; // simulate SCRIPT FLUSH after registration

    const decision = await store.attempt(SALE_ID, "a@x.com");
    expect(decision).toEqual({ verdict: "OK", remaining: 7 });
    expect(client.eval).toHaveBeenCalledWith(ORDER_SCRIPT_SOURCE, {
      keys: [stockKeyFor(SALE_ID), ordersKeyFor(SALE_ID)],
      arguments: ["a@x.com"],
    });

    // Re-registration is fired; subsequent attempts use EVALSHA again.
    await vi.waitFor(() => expect(client.scriptLoad).toHaveBeenCalledTimes(2));
    const next = await store.attempt(SALE_ID, "b@x.com");
    expect(next).toEqual({ verdict: "ALREADY", remaining: 12 });
    expect(client.eval).toHaveBeenCalledTimes(1);
  });

  it("wraps non-NOSCRIPT command rejections into RedisUnavailableError", async () => {
    const client = fakeClient({
      evalSha: vi.fn(async () => {
        throw new Error("The client is closed");
      }),
    });
    const store = createOrderStore(client, OPTS);
    await store.register();
    await expect(store.attempt(SALE_ID, "a@x.com")).rejects.toBeInstanceOf(RedisUnavailableError);
    expect(client.eval).not.toHaveBeenCalled(); // no blind fallback on non-NOSCRIPT
  });

  it("a hung command fails closed within the bounded timeout (a timeout IS unreachable)", async () => {
    const client = fakeClient({
      evalSha: vi.fn(() => new Promise<never>(() => {})),
    });
    const store = createOrderStore(client, { commandTimeoutMs: 20 });
    await store.register();
    await expect(store.attempt(SALE_ID, "a@x.com")).rejects.toBeInstanceOf(RedisUnavailableError);
  });

  it("rejects malformed replies instead of guessing a verdict", async () => {
    for (const bad of [null, "OK", ["MAYBE", 5], ["OK"], ["OK", "not-a-number"]]) {
      const client = fakeClient({ evalSha: vi.fn(async () => bad) });
      const store = createOrderStore(client, OPTS);
      await store.register();
      await expect(store.attempt(SALE_ID, "a@x.com")).rejects.toBeInstanceOf(RedisUnavailableError);
    }
  });

  it("register() failure fails closed (boot aborts before listen())", async () => {
    const client = fakeClient({
      scriptLoad: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    });
    const store = createOrderStore(client, OPTS);
    await expect(store.register()).rejects.toBeInstanceOf(RedisUnavailableError);
  });

  it("hasOrdered() issues one SISMEMBER on orders:{saleId}:users and coerces the reply", async () => {
    const client = fakeClient({ sIsMember: vi.fn(async (_k: string, m: string) => (m === "in@x.com" ? 1 : 0)) });
    const store = createOrderStore(client, OPTS);
    expect(await store.hasOrdered(SALE_ID, "in@x.com")).toBe(true);
    expect(await store.hasOrdered(SALE_ID, "out@x.com")).toBe(false);
    expect(client.sIsMember).toHaveBeenCalledWith(ordersKeyFor(SALE_ID), "in@x.com");
  });

  it("hasOrdered() with a different saleId targets a different key", async () => {
    const client = fakeClient();
    const store = createOrderStore(client, OPTS);
    await store.hasOrdered("other-sale", "x@x.com");
    expect(client.sIsMember).toHaveBeenCalledWith(ordersKeyFor("other-sale"), "x@x.com");
  });

  it("hasOrdered() rejection wraps into RedisUnavailableError", async () => {
    const client = fakeClient({
      sIsMember: vi.fn(async () => {
        throw new Error("The client is closed");
      }),
    });
    const store = createOrderStore(client, OPTS);
    await expect(store.hasOrdered(SALE_ID, "a@x.com")).rejects.toBeInstanceOf(RedisUnavailableError);
  });
});
