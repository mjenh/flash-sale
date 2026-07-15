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
//
// Key namespacing: KEYS[1] = stock:{saleId}:remaining, KEYS[2] =
// orders:{saleId}:users — passed via KEYS[] so Redis Cluster can hash-slot
// the command. Key names are constructed here from the caller-supplied saleId
// via stockKeyFor/ordersKeyFor and forwarded to the script; the script never
// hard-codes or derives key names itself.
import { readFileSync } from "node:fs";
import { RedisUnavailableError, stockKeyFor } from "./stock.ts";

/** The authoritative script source — order.lua is the implementation of record. */
export const ORDER_SCRIPT_SOURCE = readFileSync(new URL("./order.lua", import.meta.url), "utf8");

export function ordersKeyFor(saleId: string): string {
  return `orders:${saleId}:users`;
}

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
  /** Runs the Lua script — the only runtime writer of the two sale-scoped keys. */
  attempt(saleId: string, email: string): Promise<OrderDecision>;
  /** One SISMEMBER — the outside-window already-vs-inactive probe. */
  hasOrdered(saleId: string, email: string): Promise<boolean>;
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
  // Finding #11: guard against a negative remaining value. In normal operation
  // the Lua script only DECRs when stock > 0, so remaining can never go below
  // 0 on the OK path. A negative value can only arise from external mutation
  // of the key (operator error). Fail closed rather than silently propagate a
  // corrupt count — the next boot's cold rebuild will restore truth.
  if (remaining < 0) {
    throw new RedisUnavailableError(new Error(`stock key went negative (${remaining}); external mutation suspected`));
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

  // KEYS[1] = stockKey, KEYS[2] = ordersKey — passed so Redis Cluster can
  // hash-slot on the keys. ARGV[1] = email (the only per-call argument).
  const scriptOptions = (saleId: string, email: string) => ({
    keys: [stockKeyFor(saleId), ordersKeyFor(saleId)],
    arguments: [email],
  });

  return {
    async register(): Promise<void> {
      await loadScript();
    },

    async attempt(saleId: string, email: string): Promise<OrderDecision> {
      const cachedSha = sha;
      let reply: unknown;
      try {
        reply =
          cachedSha === undefined
            ? await raced(client.eval(ORDER_SCRIPT_SOURCE, scriptOptions(saleId, email)), commandTimeoutMs)
            : await raced(
                client.evalSha(cachedSha, scriptOptions(saleId, email)),
                commandTimeoutMs,
              );
      } catch (err) {
        if (!isNoScript(err)) {
          throw err instanceof RedisUnavailableError ? err : new RedisUnavailableError(err);
        }
        // Script cache lost (e.g. SCRIPT FLUSH / restart without AOF of the
        // cache) — automatic fallback: EVAL the source and re-register.
        try {
          reply = await raced(
            client.eval(ORDER_SCRIPT_SOURCE, scriptOptions(saleId, email)),
            commandTimeoutMs,
          );
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

    async hasOrdered(saleId: string, email: string): Promise<boolean> {
      try {
        const reply = await raced(client.sIsMember(ordersKeyFor(saleId), email), commandTimeoutMs);
        return Boolean(reply);
      } catch (err) {
        throw err instanceof RedisUnavailableError ? err : new RedisUnavailableError(err);
      }
    },
  };
}
