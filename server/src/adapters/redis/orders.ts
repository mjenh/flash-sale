// Redis adapter for the atomic order decision. The decision logic lives in
// ./order.lua (the single authoritative source, read once at module init);
// this file only registers and invokes it.
//
// register() runs SCRIPT LOAD at boot (strictly before listen()) and caches
// the sha; attempt() invokes via EVALSHA and falls back to EVAL (re-caching
// the sha) if Redis replies NOSCRIPT (e.g. after a script-cache flush).
//
// Fail closed: every command is bounded by redisCommandTimeoutMs; a timeout,
// any command rejection, or an unparseable reply surfaces as
// RedisUnavailableError -> 503 at the central error middleware.
import { readFileSync } from "node:fs";
import { RedisUnavailableError } from "./stock.ts";

const ORDERS_KEY = "orders:users";
const STOCK_KEY = "stock:remaining";

/** The authoritative script source — order.lua is the implementation of record. */
export const ORDER_SCRIPT_SOURCE = readFileSync(new URL("./order.lua", import.meta.url), "utf8");

export type OrderVerdict = "OK" | "ALREADY" | "SOLD_OUT";

export interface OrderDecision {
  verdict: OrderVerdict;
  /** Stock after this call (post-DECR on OK — used for the sold-out signal). */
  remaining: number;
}

/** Narrow command surface — structurally satisfied by node-redis RedisClientType. */
export interface OrderCommands {
  scriptLoad(script: string): Promise<string>;
  evalSha(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  sIsMember(key: string, member: string): Promise<unknown>;
}

export interface OrderStoreOptions {
  commandTimeoutMs: number;
}

export interface OrderStore {
  /** SCRIPT LOAD + sha cache. Called once in bootstrap, before listen(). */
  register(): Promise<void>;
  /** Runs the Lua script — the only runtime writer of the two keys. */
  attempt(email: string): Promise<OrderDecision>;
  /** One SISMEMBER — the outside-window already-vs-inactive probe. */
  hasOrdered(email: string): Promise<boolean>;
}

function isNoScript(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("NOSCRIPT");
}

/** Race a command against the timeout WITHOUT wrapping the command's own
 *  rejection — attempt() must see a raw NOSCRIPT before failing closed. */
async function raced<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new RedisUnavailableError(new Error(`Redis command timed out after ${timeoutMs} ms`)));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parseDecision(reply: unknown): OrderDecision {
  if (!Array.isArray(reply) || reply.length !== 2) {
    throw new RedisUnavailableError(new Error(`unexpected order script reply: ${JSON.stringify(reply)}`));
  }
  const [verdict, rawRemaining] = reply as [unknown, unknown];
  if (verdict !== "OK" && verdict !== "ALREADY" && verdict !== "SOLD_OUT") {
    // Never guess a verdict — fail closed.
    throw new RedisUnavailableError(new Error(`unexpected order verdict: ${String(verdict)}`));
  }
  const remaining = Number(rawRemaining);
  if (!Number.isFinite(remaining)) {
    throw new RedisUnavailableError(new Error(`unexpected remaining stock: ${String(rawRemaining)}`));
  }
  return { verdict, remaining };
}

export function createOrderStore(
  client: OrderCommands,
  { commandTimeoutMs }: OrderStoreOptions,
): OrderStore {
  let sha: string | undefined;

  const loadScript = async (): Promise<string> => {
    try {
      sha = await raced(client.scriptLoad(ORDER_SCRIPT_SOURCE), commandTimeoutMs);
      return sha;
    } catch (err) {
      throw err instanceof RedisUnavailableError ? err : new RedisUnavailableError(err);
    }
  };

  const scriptOptions = (email: string) => ({
    keys: [ORDERS_KEY, STOCK_KEY],
    arguments: [email],
  });

  return {
    async register(): Promise<void> {
      await loadScript();
    },

    async attempt(email: string): Promise<OrderDecision> {
      const cachedSha = sha;
      let reply: unknown;
      try {
        reply =
          cachedSha === undefined
            ? await raced(client.eval(ORDER_SCRIPT_SOURCE, scriptOptions(email)), commandTimeoutMs)
            : await raced(client.evalSha(cachedSha, scriptOptions(email)), commandTimeoutMs);
      } catch (err) {
        if (!isNoScript(err)) {
          throw err instanceof RedisUnavailableError ? err : new RedisUnavailableError(err);
        }
        // Script cache lost (e.g. SCRIPT FLUSH / restart without AOF of the
        // cache) — automatic fallback: EVAL the source and re-register.
        try {
          reply = await raced(client.eval(ORDER_SCRIPT_SOURCE, scriptOptions(email)), commandTimeoutMs);
        } catch (evalErr) {
          throw evalErr instanceof RedisUnavailableError
            ? evalErr
            : new RedisUnavailableError(evalErr);
        }
        void loadScript().catch(() => {
          // Re-cache is best-effort; the next attempt() falls back again.
        });
      }
      return parseDecision(reply);
    },

    async hasOrdered(email: string): Promise<boolean> {
      try {
        const reply = await raced(client.sIsMember(ORDERS_KEY, email), commandTimeoutMs);
        return Boolean(reply);
      } catch (err) {
        throw err instanceof RedisUnavailableError ? err : new RedisUnavailableError(err);
      }
    },
  };
}
