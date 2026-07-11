// AD-4 restart-safety ops on the two Redis keys. The boot rebuild is one of
// only three permitted writers (AD-1: the Lua script while serving, THIS
// rebuild strictly pre-listen(), and the offline reset script).
//
// stock:remaining doubles as the warm/cold sentinel, so rebuild() writes it
// LAST (DEL -> SADD -> SET): a crash mid-rebuild leaves the sentinel absent
// and the next boot simply re-runs the cold path — idempotent.
//
// Fail closed (AD-5): every command is bounded; a timeout or rejection
// surfaces as RedisUnavailableError, which rejects bootstrap() and exits the
// process non-zero before listen() — the boot-time form of fail-closed.
import { bounded } from "./stock.ts";

const ORDERS_KEY = "orders:users";
const STOCK_KEY = "stock:remaining";

/** Narrow command surface — structurally satisfied by node-redis RedisClientType. */
export interface ReconcileCommands {
  exists(key: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sAdd(key: string, members: string[]): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
}

export interface ReconcilerOptions {
  commandTimeoutMs: number;
}

export interface Reconciler {
  /** Warm/cold sentinel: does stock:remaining exist? Warm start touches nothing. */
  hasStockKey(): Promise<boolean>;
  /** Cold rebuild from MongoDB truth: membership first, stock (sentinel) last. */
  rebuild(emails: string[], remaining: number): Promise<void>;
}

export function createReconciler(
  client: ReconcileCommands,
  { commandTimeoutMs }: ReconcilerOptions,
): Reconciler {
  return {
    async hasStockKey(): Promise<boolean> {
      return Boolean(await bounded(client.exists(STOCK_KEY), commandTimeoutMs));
    },

    async rebuild(emails: string[], remaining: number): Promise<void> {
      await bounded(client.del(ORDERS_KEY), commandTimeoutMs);
      if (emails.length > 0) {
        await bounded(client.sAdd(ORDERS_KEY, emails), commandTimeoutMs);
      }
      await bounded(client.set(STOCK_KEY, String(remaining)), commandTimeoutMs);
    },
  };
}
