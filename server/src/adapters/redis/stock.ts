// Redis adapter for the `stock:remaining` key — reads for the sale-status
// service, plus the interim pre-listen() boot seed (SETNX only: a warm restart
// against surviving Redis state touches nothing; full AD-4 reconciliation
// replaces this in Story 1.4). Zero business rules (AD-7).
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
  setNX(key: string, value: string): Promise<unknown>;
}

export interface StockStoreOptions {
  commandTimeoutMs: number;
}

export interface StockStore {
  /** Current remaining stock. Throws RedisUnavailableError when Redis is
   *  unreachable, a command times out, or the key is missing (fail closed). */
  getRemaining(): Promise<number>;
  /** Interim boot seed: SETNX stock:remaining <quantity>. Idempotent — never
   *  overwrites surviving state (AD-1/AD-4 writer discipline). */
  seedIfAbsent(quantity: number): Promise<void>;
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
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
        // Key lost mid-run (pre-1.4 reconciliation): never fabricate a number —
        // 0 would lie "sold_out". Fail closed; a restart re-seeds.
        throw new RedisUnavailableError(new Error(`${STOCK_KEY} key is missing`));
      }
      return Number.parseInt(raw, 10);
    },

    async seedIfAbsent(quantity: number): Promise<void> {
      await bounded(client.setNX(STOCK_KEY, String(quantity)), commandTimeoutMs);
    },
  };
}
