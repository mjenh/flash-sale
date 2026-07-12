// Shared in-memory fake Redis client for endpoint tests. Exposes exactly the
// command surface production code uses (get/set/exists/del/sAdd/sIsMember/
// scriptLoad/evalSha/eval/publish/duplicate) so tests boot through the REAL
// bootstrap(); swap it for a real client against compose-run Redis and the
// endpoint test files run unchanged.
//
// Story 1.6 pub/sub bus: publish() delivers synchronously to listeners
// subscribed through duplicate()d subscriber clients (all duplicates share
// one bus). Test seams: deliver() injects an event at the subscription
// without a publish (drives the broadcaster while `failing` blocks the bus),
// emitSubscriberError() fires the subscriber connection's error listeners
// (the AD-5 connection-lost trigger), and failingPublish fails ONLY
// publishes (proves publish failures never alter HTTP outcomes while reads
// stay healthy).
//
// evalSha/eval execute a faithful, line-for-line JS port of order.lua — the
// .lua file remains the single authoritative implementation (its keys and
// command order are pinned by order-script.test.ts). Each eval executes
// SYNCHRONOUSLY within one call, the honest in-process analogue of Redis's
// single-threaded script atomicity: nothing interleaves mid-decision.
import { createHash } from "node:crypto";
import { ORDER_SCRIPT_SOURCE } from "../../src/adapters/redis/orders.ts";
import type { RedisClient } from "../../src/adapters/redis/client.ts";

export interface FakeRedis {
  kv: Map<string, string>;
  sets: Map<string, Set<string>>;
  /** When true, every command rejects (AD-5 fail-closed path). */
  failing: boolean;
  /** When true, ONLY publish rejects — reads stay healthy (Story 1.6 AC 5:
   *  publish failures never alter HTTP outcomes). */
  failingPublish: boolean;
  /** Messages successfully published to any channel, in order. */
  published: string[];
  /** Inject an event at the subscription as if it had been published —
   *  drives the broadcaster without touching the publisher. */
  deliver(channel: string, message: string): void;
  /** Fire the subscriber connection's registered error listeners (AD-5). */
  emitSubscriberError(err: Error): void;
  /** Simulates SCRIPT FLUSH: EVALSHA answers NOSCRIPT until re-loaded. */
  flushScripts(): void;
  /** Simulates a full Redis wipe (FLUSHALL + restart without AOF) — the
   *  AD-4 cold-restart precondition. */
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

export function createFakeRedis(initial?: { stock?: string }): FakeRedis {
  const kv = new Map<string, string>();
  if (initial?.stock !== undefined) {
    kv.set("stock:remaining", initial.stock);
  }
  const sets = new Map<string, Set<string>>();
  const scripts = new Map<string, string>();
  const calls = { evalSha: 0, eval: 0, sIsMember: 0, exists: 0, del: 0, set: 0, sAdd: 0, publish: 0 };

  // Pub/sub bus shared by the main client and every duplicate()d subscriber.
  const channelListeners = new Map<string, Set<(message: string) => void>>();
  const subscriberErrorListeners = new Set<(err: Error) => void>();

  const fake: FakeRedis = {
    kv,
    sets,
    failing: false,
    failingPublish: false,
    published: [],
    deliver: (channel, message) => {
      for (const listener of [...(channelListeners.get(channel) ?? [])]) {
        listener(message);
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
  const runOrderScript = (keys: string[], args: string[]): [string, number] => {
    const [ordersKey, stockKey] = keys as [string, string];
    const email = args[0] as string;
    const rawStock = kv.get(stockKey);
    const stock = rawStock === undefined ? Number.NaN : Number.parseInt(rawStock, 10);
    if (Number.isNaN(stock)) {
      throw new Error("stock:remaining missing"); // error_reply analogue
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
    publish: async (channel: string, message: string) => {
      assertUp();
      calls.publish += 1;
      if (fake.failingPublish) {
        throw new Error("publish rejected (failingPublish)");
      }
      fake.published.push(message);
      const listeners = channelListeners.get(channel) ?? new Set();
      for (const listener of [...listeners]) {
        listener(message);
      }
      return listeners.size;
    },
    duplicate: () => {
      // Subscriber-side fake client sharing the bus; its commands honor
      // `failing` like every other command on the fake.
      const mine = new Map<string, (message: string) => void>();
      const subscriber = {
        isOpen: false,
        connect: async () => {
          assertUp();
          subscriber.isOpen = true;
        },
        subscribe: async (channel: string, listener: (message: string) => void) => {
          assertUp();
          mine.set(channel, listener);
          const listeners = channelListeners.get(channel) ?? new Set();
          listeners.add(listener);
          channelListeners.set(channel, listeners);
        },
        unsubscribe: async (channel: string) => {
          assertUp();
          const listener = mine.get(channel);
          if (listener !== undefined) {
            channelListeners.get(channel)?.delete(listener);
            mine.delete(channel);
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
export function orderSetSize(fake: FakeRedis): number {
  return (fake.sets.get("orders:users") ?? new Set()).size;
}

/** Membership helper for AD-4 rebuild assertions. */
export function orderSetMembers(fake: FakeRedis): string[] {
  return [...(fake.sets.get("orders:users") ?? new Set<string>())].sort();
}
