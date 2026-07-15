// Shared in-memory fake Redis client for endpoint tests. Exposes exactly the
// command surface production code uses (get/set/exists/del/sAdd/sIsMember/
// scriptLoad/evalSha/eval/publish/duplicate/xAdd/pSubscribe/pUnsubscribe) so
// tests boot through the REAL bootstrap(); swap it for a real client against
// compose-run Redis and the endpoint test files run unchanged.
//
// Pub/sub bus: publish() delivers synchronously to both exact-channel and
// pattern listeners. deliver() injects an event at the subscription without a
// publish (drives the broadcaster while `failing` blocks the bus),
// emitSubscriberError() fires the subscriber connection's error listeners
// (connection-lost trigger), and failingPublish fails ONLY publishes
// (proves publish failures never alter HTTP outcomes while reads stay
// healthy).
//
// evalSha/eval execute a faithful, line-for-line JS port of order.lua — the
// .lua file remains the single authoritative implementation (its keys and
// command order are pinned by order-script.test.ts). Each eval executes
// SYNCHRONOUSLY within one call, the honest in-process analogue of Redis's
// single-threaded script atomicity: nothing interleaves mid-decision.
//
// KEYS[1] = stock:{saleId}:remaining, KEYS[2] = orders:{saleId}:users,
// ARGV[1] = email — mirrors the updated order.lua contract (finding #1).
import { createHash } from "node:crypto";
import type { RedisClient } from "../../src/adapters/redis/client.ts";
import { ORDER_SCRIPT_SOURCE, ordersKeyFor } from "../../src/adapters/redis/orders.ts";
import { stockKeyFor } from "../../src/adapters/redis/stock.ts";

export interface FakeRedis {
  kv: Map<string, string>;
  sets: Map<string, Set<string>>;
  /** When true, every command rejects (fail-closed path). */
  failing: boolean;
  /** When true, ONLY publish rejects — reads stay healthy (publish failures
   *  never alter HTTP outcomes). */
  failingPublish: boolean;
  /** Messages successfully published to any channel, in order. */
  published: string[];
  /** Stream entries added via xAdd, keyed by stream key. */
  streams: Map<string, Array<{ id: string; fields: Record<string, string> }>>;
  /** Inject an event at the subscription as if it had been published —
   *  drives the broadcaster without touching the publisher. */
  deliver(channel: string, message: string): void;
  /** Fire the subscriber connection's registered error listeners. */
  emitSubscriberError(err: Error): void;
  /** Simulates SCRIPT FLUSH: EVALSHA answers NOSCRIPT until re-loaded. */
  flushScripts(): void;
  /** Simulates a full Redis wipe (FLUSHALL + restart without AOF) — the
   *  cold-restart precondition. */
  flush(): void;
  /** Command spies for negative-space assertions (warm boots write nothing). */
  calls: {
    evalSha: number;
    eval: number;
    sIsMember: number;
    exists: number;
    del: number;
    set: number;
    sAdd: number;
    publish: number;
  };
  client: RedisClient;
}

export function createFakeRedis(initial?: { stock?: string; saleId?: string }): FakeRedis {
  const kv = new Map<string, string>();
  if (initial?.stock !== undefined) {
    if (initial.saleId === undefined) {
      throw new Error("createFakeRedis: saleId is required to seed initial stock (keys are sale-scoped)");
    }
    kv.set(stockKeyFor(initial.saleId), initial.stock);
  }
  const sets = new Map<string, Set<string>>();
  const scripts = new Map<string, string>();
  const calls = { evalSha: 0, eval: 0, sIsMember: 0, exists: 0, del: 0, set: 0, sAdd: 0, publish: 0 };

  // Pub/sub bus shared by the main client and every duplicate()d subscriber.
  const channelListeners = new Map<string, Set<(message: string) => void>>();
  // Pattern listeners (pSubscribe): each entry is a glob pattern → set of
  // listeners. On publish/deliver, patterns are matched with globMatch().
  const patternListeners = new Map<string, Set<(message: string, channel: string) => void>>();
  const subscriberErrorListeners = new Set<(err: Error) => void>();

  /** Minimal Redis-compatible glob match (only * is used in practice). */
  function globMatch(pattern: string, channel: string): boolean {
    const regex = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
    );
    return regex.test(channel);
  }

  const streams = new Map<string, Array<{ id: string; fields: Record<string, string> }>>();
  const fake: FakeRedis = {
    kv,
    sets,
    streams,
    failing: false,
    failingPublish: false,
    published: [],
    deliver: (channel, message) => {
      for (const listener of [...(channelListeners.get(channel) ?? [])]) {
        listener(message);
      }
      // Also fire any pattern listeners that match the channel.
      for (const [pattern, listeners] of patternListeners) {
        if (globMatch(pattern, channel)) {
          for (const listener of [...listeners]) {
            listener(message, channel);
          }
        }
      }
    },
    emitSubscriberError: (err) => {
      for (const listener of [...subscriberErrorListeners]) {
        listener(err);
      }
    },
    flushScripts: () => scripts.clear(),
    flush: () => {
      kv.clear();
      sets.clear();
      scripts.clear();
      streams.clear();
    },
    calls,
    client: undefined as unknown as RedisClient,
  };

  const assertUp = (): void => {
    if (fake.failing) {
      throw new Error("The client is closed");
    }
  };

  // Faithful port of order.lua, executed atomically (synchronously) per call.
  // Branch order mirrors the .lua source exactly:
  //   missing stock key -> error | ALREADY | SOLD_OUT | SADD + DECR -> OK.
  // KEYS[1] = stockKey, KEYS[2] = ordersKey, ARGV[1] = email — mirrors the
  // updated Lua contract (finding #1: keys via KEYS[] for Cluster routing).
  const runOrderScript = (keys: string[], args: string[]): [string, number] => {
    const stockKey = keys[0] as string;
    const ordersKey = keys[1] as string;
    const email = args[0] as string;
    const rawStock = kv.get(stockKey);
    const stock = rawStock === undefined ? Number.NaN : Number.parseInt(rawStock, 10);
    if (Number.isNaN(stock)) {
      throw new Error(`${stockKey} missing`); // error_reply analogue
    }
    const members = sets.get(ordersKey) ?? new Set<string>();
    if (members.has(email)) {
      return ["ALREADY", stock];
    }
    if (stock <= 0) {
      return ["SOLD_OUT", stock];
    }
    members.add(email);
    sets.set(ordersKey, members);
    const remaining = stock - 1;
    kv.set(stockKey, String(remaining));
    return ["OK", remaining];
  };

  const sha1 = (source: string): string => createHash("sha1").update(source).digest("hex");

  fake.client = {
    isOpen: true,
    get: async (key: string) => {
      assertUp();
      return kv.get(key) ?? null;
    },
    set: async (key: string, value: string) => {
      assertUp();
      calls.set += 1;
      kv.set(key, value);
      return "OK";
    },
    exists: async (key: string) => {
      assertUp();
      calls.exists += 1;
      return kv.has(key) || sets.has(key) ? 1 : 0;
    },
    del: async (key: string) => {
      assertUp();
      calls.del += 1;
      const had = kv.delete(key);
      const hadSet = sets.delete(key);
      return had || hadSet ? 1 : 0;
    },
    sAdd: async (key: string, members: string[]) => {
      assertUp();
      calls.sAdd += 1;
      const set = sets.get(key) ?? new Set<string>();
      let added = 0;
      for (const member of members) {
        if (!set.has(member)) {
          set.add(member);
          added += 1;
        }
      }
      sets.set(key, set);
      return added;
    },
    sIsMember: async (key: string, member: string) => {
      assertUp();
      calls.sIsMember += 1;
      return (sets.get(key) ?? new Set()).has(member) ? 1 : 0;
    },
    scriptLoad: async (source: string) => {
      assertUp();
      const sha = sha1(source);
      scripts.set(sha, source);
      return sha;
    },
    evalSha: async (sha: string, options: { keys: string[]; arguments: string[] }) => {
      assertUp();
      calls.evalSha += 1;
      const source = scripts.get(sha);
      if (source === undefined) {
        throw new Error("NOSCRIPT No matching script. Please use EVAL.");
      }
      if (source !== ORDER_SCRIPT_SOURCE) {
        throw new Error(`fake-redis only implements order.lua, got sha ${sha}`);
      }
      return runOrderScript(options.keys, options.arguments);
    },
    eval: async (source: string, options: { keys: string[]; arguments: string[] }) => {
      assertUp();
      calls.eval += 1;
      if (source !== ORDER_SCRIPT_SOURCE) {
        throw new Error("fake-redis only implements order.lua");
      }
      return runOrderScript(options.keys, options.arguments);
    },
    xAdd: async (key: string, _id: string, fields: Record<string, string>, _options?: unknown) => {
      assertUp();
      const entries = streams.get(key) ?? [];
      const entryId = `${Date.now()}-${entries.length}`;
      entries.push({ id: entryId, fields });
      streams.set(key, entries);
      return entryId;
    },
    publish: async (channel: string, message: string) => {
      assertUp();
      calls.publish += 1;
      if (fake.failingPublish) {
        throw new Error("publish rejected (failingPublish)");
      }
      fake.published.push(message);
      // Exact-channel listeners.
      const exactListeners = channelListeners.get(channel) ?? new Set();
      for (const listener of [...exactListeners]) {
        listener(message);
      }
      // Pattern listeners (finding #5: pSubscribe support).
      for (const [pattern, listeners] of patternListeners) {
        if (globMatch(pattern, channel)) {
          for (const listener of [...listeners]) {
            listener(message, channel);
          }
        }
      }
      return exactListeners.size;
    },
    duplicate: () => {
      // Subscriber-side fake client sharing the bus; its commands honor
      // `failing` like every other command on the fake.
      const minePattern = new Map<string, (message: string, channel: string) => void>();
      const subscriber = {
        isOpen: false,
        connect: async () => {
          assertUp();
          subscriber.isOpen = true;
        },
        // pSubscribe/pUnsubscribe for wildcard channel patterns.
        pSubscribe: async (pattern: string, listener: (message: string, channel: string) => void) => {
          assertUp();
          minePattern.set(pattern, listener);
          const listeners = patternListeners.get(pattern) ?? new Set();
          listeners.add(listener);
          patternListeners.set(pattern, listeners);
        },
        pUnsubscribe: async (pattern?: string) => {
          assertUp();
          if (pattern !== undefined) {
            const listener = minePattern.get(pattern);
            if (listener !== undefined) {
              patternListeners.get(pattern)?.delete(listener);
              minePattern.delete(pattern);
            }
          } else {
            for (const [p, listener] of minePattern) {
              patternListeners.get(p)?.delete(listener);
            }
            minePattern.clear();
          }
        },
        on: (event: string, listener: (err: Error) => void) => {
          if (event === "error") {
            subscriberErrorListeners.add(listener);
          }
          return subscriber;
        },
        destroy: () => {
          subscriber.isOpen = false;
        },
        close: async () => {
          subscriber.isOpen = false;
        },
      };
      return subscriber as unknown as RedisClient;
    },
  } as unknown as RedisClient;

  return fake;
}

/** Set-size helper for count assertions. */
export function orderSetSize(fake: FakeRedis, saleId: string): number {
  return (fake.sets.get(ordersKeyFor(saleId)) ?? new Set()).size;
}

/** Membership helper for rebuild assertions. */
export function orderSetMembers(fake: FakeRedis, saleId: string): string[] {
  return [...(fake.sets.get(ordersKeyFor(saleId)) ?? new Set<string>())].sort();
}

/** Re-exported so endpoint tests can build the exact sale-scoped key names
 *  for direct kv/sets assertions without duplicating the naming scheme. */
export { ordersKeyFor, stockKeyFor };
