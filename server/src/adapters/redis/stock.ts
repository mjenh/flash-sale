// Redis adapter for the `stock:{saleId}:remaining` key — reads for the
// sale-status service. Writes happen only via the Lua script (serving), the
// boot rebuild in reconcile.ts (pre-listen()), or the offline reset script.
//
// Fail closed: every command is bounded by redisCommandTimeoutMs; a timeout
// or any command rejection surfaces as RedisUnavailableError, which the
// central error middleware maps to 503.
//
// Keys are namespaced by saleId (the resolved Sale's Mongo ObjectId string)
// so multiple sale records can coexist without collision. The v1.0 flat
// `stock:remaining` key is no longer written or read by the live request
// path — the flat-key migrator (migrate.ts) handles any surviving flat-key data.

export function stockKeyFor(saleId: string): string {
  return `stock:${saleId}:remaining`;
}

/** Typed fail-closed signal. `expose` (http-errors convention) tells the
 *  central middleware to keep this 5xx message instead of collapsing it. */
export class RedisUnavailableError extends Error {
  override name = "RedisUnavailableError";
  readonly status = 503;
  readonly expose = true;

  constructor(cause?: unknown) {
    super("Service temporarily unavailable.", cause === undefined ? undefined : { cause });
  }
}

/** Narrow command surface — structurally satisfied by node-redis RedisClientType. */
export interface StockCommands {
  get(key: string): Promise<string | null>;
}

export interface StockStoreOptions {
  commandTimeoutMs: number;
}

export interface StockStore {
  /** Current remaining stock for the given sale. Throws RedisUnavailableError
   *  when Redis is unreachable, a command times out, or the key is missing
   *  (fail closed). */
  getRemaining(saleId: string): Promise<number>;
}

/** Bound a command by the per-command timeout, wrapping timeout and any
 *  command rejection into RedisUnavailableError. Shared with reconcile.ts. */
export async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
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
  } catch (err) {
    throw err instanceof RedisUnavailableError ? err : new RedisUnavailableError(err);
  } finally {
    clearTimeout(timer);
  }
}

export function createStockStore(
  client: StockCommands,
  { commandTimeoutMs }: StockStoreOptions,
): StockStore {
  return {
    async getRemaining(saleId: string): Promise<number> {
      const key = stockKeyFor(saleId);
      const raw = await bounded(client.get(key), commandTimeoutMs);
      if (raw === null) {
        // Key lost mid-run: never fabricate a number — 0 would lie "sold_out".
        // Fail closed; the next boot's cold rebuild restores truth.
        throw new RedisUnavailableError(new Error(`${key} key is missing`));
      }
      // Strict integer only. `Number.parseInt("12x", 10)` returns 12 — trailing
      // garbage slips a plain parseInt + isFinite guard and fabricates a count.
      // Require the whole (trimmed) value to be an integer before trusting it.
      if (!/^-?\d+$/.test(raw.trim())) {
        // A non-integer value would read as NaN or a truncated number ->
        // fabricated truth. Fail closed instead — mirrors the order-store guard.
        throw new RedisUnavailableError(new Error(`${key} is not an integer: "${raw}"`));
      }
      const remaining = Number.parseInt(raw, 10);
      if (!Number.isFinite(remaining)) {
        throw new RedisUnavailableError(new Error(`${key} is not an integer: "${raw}"`));
      }
      return remaining;
    },
  };
}
