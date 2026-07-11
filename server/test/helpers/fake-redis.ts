// Shared in-memory fake Redis client for endpoint tests. Exposes exactly the
// command surface production code uses (get/setNX/sIsMember/scriptLoad/
// evalSha/eval) so tests boot through the REAL bootstrap(); swap it for a real
// client against compose-run Redis and the endpoint test files run unchanged.
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
  /** Simulates SCRIPT FLUSH: EVALSHA answers NOSCRIPT until re-loaded. */
  flushScripts(): void;
  /** Command spies for negative-space assertions. */
  calls: { evalSha: number; eval: number; sIsMember: number };
  client: RedisClient;
}

export function createFakeRedis(initial?: { stock?: string }): FakeRedis {
  const kv = new Map<string, string>();
  if (initial?.stock !== undefined) {
    kv.set("stock:remaining", initial.stock);
  }
  const sets = new Map<string, Set<string>>();
  const scripts = new Map<string, string>();
  const calls = { evalSha: 0, eval: 0, sIsMember: 0 };

  const fake: FakeRedis = {
    kv,
    sets,
    failing: false,
    flushScripts: () => scripts.clear(),
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
    setNX: async (key: string, value: string) => {
      assertUp();
      if (kv.has(key)) {
        return 0;
      }
      kv.set(key, value);
      return 1;
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
  } as unknown as RedisClient;

  return fake;
}

/** Set-size helper for count assertions. */
export function orderSetSize(fake: FakeRedis): number {
  return (fake.sets.get("orders:users") ?? new Set()).size;
}
