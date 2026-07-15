// v1.0 -> v1.1 one-time data migration. The v1.0 flat Redis keys
// (`stock:remaining`, `orders:users`) predate saleId namespacing; the live
// request path has not read or written them since — this adapter is the ONE
// transient exception, and only at boot.
//
// Runs at boot strictly BEFORE the warm/cold reconciliation (bootstrap.ts
// wires it that way): if this step RENAMEs the flat keys into their
// namespaced equivalents, reconciliation's hasStockKey(saleId) warm-start
// check then correctly sees them as warm and skips rebuilding — migrated
// state is preserved rather than clobbered by a cold rebuild.
//
// Guarded with EXISTS checks rather than a try/catch around RENAME (Redis
// throws "ERR no such key" when the source is missing) — reads as a plain
// decision tree and is trivially testable with fakes:
//   namespaced stock key exists?
//     yes -> flat keys also present? -> DEL them (namespaced wins), warn.
//         -> no flat keys -> no-op.
//     no  -> flat keys present? -> RENAME both to their namespaced form, warn.
//         -> no flat keys either -> no-op (fresh v1.1 install, AC2).
import { bounded, stockKeyFor } from "./stock.ts";
import { ordersKeyFor } from "./orders.ts";

const FLAT_STOCK_KEY = "stock:remaining";
const FLAT_ORDERS_KEY = "orders:users";

/** Narrow command surface — structurally satisfied by node-redis RedisClientType. */
export interface MigrateCommands {
  exists(key: string): Promise<unknown>;
  rename(source: string, destination: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** The subset of pino's Logger this adapter needs — narrow so fakes are trivial. */
export interface MigrateLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface MigrateOptions {
  commandTimeoutMs: number;
}

export interface FlatKeyMigrator {
  /** One-time v1.0 -> v1.1 flat-key migration for the resolved active sale.
   *  No-op on a fresh v1.1 install (no flat keys present, AC2). */
  migrate(saleId: string, slug: string): Promise<void>;
}

export function createFlatKeyMigrator(
  client: MigrateCommands,
  logger: MigrateLogger,
  { commandTimeoutMs }: MigrateOptions,
): FlatKeyMigrator {
  return {
    async migrate(saleId: string, slug: string): Promise<void> {
      const namespacedStockKey = stockKeyFor(saleId);
      const namespacedExists = Boolean(
        await bounded(client.exists(namespacedStockKey), commandTimeoutMs),
      );
      const flatStockExists = Boolean(await bounded(client.exists(FLAT_STOCK_KEY), commandTimeoutMs));
      const flatOrdersExists = Boolean(await bounded(client.exists(FLAT_ORDERS_KEY), commandTimeoutMs));

      if (!flatStockExists && !flatOrdersExists) {
        // Fresh v1.1 install (AC2) — nothing to migrate.
        return;
      }

      if (namespacedExists) {
        // Both namespaced and flat keys exist: the namespaced keys are
        // authoritative (hasStockKey warm-start check already treats them as
        // live state) — delete the stale flat leftovers so a future boot
        // never mistakes them for surviving v1.0 state.
        if (flatStockExists) {
          await bounded(client.del(FLAT_STOCK_KEY), commandTimeoutMs);
        }
        if (flatOrdersExists) {
          await bounded(client.del(FLAT_ORDERS_KEY), commandTimeoutMs);
        }
        logger.warn(
          { saleId, slug },
          "Both namespaced and v1.0 flat Redis keys exist for sale " +
            slug +
            "; namespaced keys take precedence and the flat keys were deleted",
        );
        return;
      }

      // Namespaced stock key absent, flat keys present: the v1.0 -> v1.1
      // upgrade case. RENAME each present flat key to its namespaced form.
      if (flatStockExists) {
        await bounded(client.rename(FLAT_STOCK_KEY, namespacedStockKey), commandTimeoutMs);
      }
      if (flatOrdersExists) {
        await bounded(client.rename(FLAT_ORDERS_KEY, ordersKeyFor(saleId)), commandTimeoutMs);
      }
      logger.warn({ saleId, slug }, `Migrated v1.0 flat Redis keys to namespaced keys for sale ${slug}`);
    },
  };
}
