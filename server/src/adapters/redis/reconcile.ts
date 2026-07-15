// Restart-safety ops on the two sale-scoped Redis keys. The boot rebuild is
// one of only three permitted writers (the Lua script while serving, this
// rebuild strictly pre-listen(), and the offline reset script).
//
// stock:{saleId}:remaining doubles as the warm/cold sentinel, so rebuild()
// writes it last (DEL -> SADD -> SET): a crash mid-rebuild leaves the
// sentinel absent and the next boot simply re-runs the cold path — idempotent.
//
// Fail closed: every command is bounded; a timeout or rejection surfaces as
// RedisUnavailableError, which rejects bootstrap() and exits the process
// non-zero before listen().
//
// Story 4.2: keys are namespaced by saleId. The v1.0 flat keys are no longer
// written or read here — Story 4.6 owns migrating any surviving flat-key data.
import { bounded, stockKeyFor } from "./stock.ts";
import { ordersKeyFor } from "./orders.ts";

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
  /** Warm/cold sentinel: does stock:{saleId}:remaining exist? Warm start
   *  touches nothing. */
  hasStockKey(saleId: string): Promise<boolean>;
  /** Cold rebuild from MongoDB truth: membership first, stock (sentinel) last. */
  rebuild(emails: string[], remaining: number, saleId: string): Promise<void>;
}

export function createReconciler(
  client: ReconcileCommands,
  { commandTimeoutMs }: ReconcilerOptions,
): Reconciler {
  return {
    async hasStockKey(saleId: string): Promise<boolean> {
      return Boolean(await bounded(client.exists(stockKeyFor(saleId)), commandTimeoutMs));
    },

    async rebuild(emails: string[], remaining: number, saleId: string): Promise<void> {
      const ordersKey = ordersKeyFor(saleId);
      await bounded(client.del(ordersKey), commandTimeoutMs);
      if (emails.length > 0) {
        await bounded(client.sAdd(ordersKey, emails), commandTimeoutMs);
      }
      await bounded(client.set(stockKeyFor(saleId), String(remaining)), commandTimeoutMs);
    },
  };
}
