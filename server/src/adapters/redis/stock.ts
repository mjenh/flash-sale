// Redis adapter for the `stock:remaining` key — reads for the sale-status
// service. Writes to this key happen only via the AD-1 Lua script (serving),
// the AD-4 boot rebuild in reconcile.ts (pre-listen()), or the offline reset
// script; the Story-1.2 interim SETNX seed was retired by Story 1.4.
// Zero business rules (AD-7).
//
// Fail closed (AD-5, NFR-9): every command is bounded by config's
// redisCommandTimeoutMs; a timeout OR any command rejection surfaces as
// RedisUnavailableError, which the central error middleware maps to
// 503 { success: false, error: "Service temporarily unavailable." }.

const STOCK_KEY = "stock:remaining";

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
  /** Current remaining stock. Throws RedisUnavailableError when Redis is
   *  unreachable, a command times out, or the key is missing (fail closed). */
  getRemaining(): Promise<number>;
}

/** Bound a command by the AD-5 per-command timeout, wrapping timeout AND any
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
    async getRemaining(): Promise<number> {
      const raw = await bounded(client.get(STOCK_KEY), commandTimeoutMs);
      if (raw === null) {
        // Key lost mid-run: never fabricate a number — 0 would lie "sold_out".
        // Fail closed; the next boot's AD-4 cold rebuild restores truth.
        throw new RedisUnavailableError(new Error(`${STOCK_KEY} key is missing`));
      }
      const remaining = Number.parseInt(raw, 10);
      if (!Number.isFinite(remaining)) {
        // A non-numeric value would read as NaN -> sold_out (fabricated truth).
        // Fail closed instead — mirrors the order-store reply guard.
        throw new RedisUnavailableError(new Error(`${STOCK_KEY} is not an integer: "${raw}"`));
      }
      return remaining;
    },
  };
}
