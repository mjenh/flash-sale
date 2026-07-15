// Mechanical implementation of the reset contract.
//
// Runs ONLY while the API is stopped: while the API serves, the Lua script
// is the sole writer of `stock:{saleId}:remaining` and `orders:{saleId}:users`,
// and a concurrent SET here could hand a buyer a 201 against stock that no
// longer exists. The guard below treats ANY answer from the API — including
// a 503 — as "still serving", and also treats a probe that TIMES OUT (a
// wedged-but-alive API) as still serving. Only a genuine connection refusal
// (ECONNREFUSED) is the green light.
//
// Wipes, in crash-safe order (the sentinel is written LAST):
//   DEL orders:{saleId}:users, deleteMany({}) on orders, orderlines, users,
//   then SET stock:{saleId}:remaining = STOCK_QUANTITY.
// stock:{saleId}:remaining IS the warm/cold sentinel (server/src/adapters/
// redis/reconcile.ts writes DEL → SADD → SET) — writing it last means a
// crash mid-reset leaves no sentinel beside a stale orders:{saleId}:users
// set, so the API's boot rebuild re-runs the cold path.
// Never touches the seed collections (products, sales, saleproducts,
// inventories) — the API re-upserts them at boot, and deleting `sales` would
// mint a fresh saleId and silently orphan the verifier's join. The `sales`
// collection IS read (never written) below, to resolve {saleId} for the
// namespaced keys — the sale document itself survives every reset.
//
// Story 4.6: keys are namespaced by saleId (v1.0's flat `stock:remaining` /
// `orders:users` are no longer referenced anywhere in this harness). The
// harness is an independent observer of the deployed stack (see config.ts's
// file header) and deliberately does not import the server workspace's
// key-naming helpers — stockKeyFor/ordersKeyFor below are this workspace's
// own copies of the same naming convention (server/src/adapters/redis/
// stock.ts, orders.ts).
import { createClient } from "redis";
import mongoose from "mongoose";
import { loadStressConfig, SALE_SLUG, type StressConfig } from "./config.ts";

export class ApiStillServingError extends Error {
  override name = "ApiStillServingError";
  constructor(detail: string) {
    super(`The API is still serving (${detail}). Stop it before resetting — while it serves, the Lua script is the sole writer of the sale state.`);
  }
}

/** The wiped collections, in order. Seed collections are absent by design. */
export const WIPED_COLLECTIONS = ["orders", "orderlines", "users"] as const;

/** v1.1 namespaced key names (Story 4.6) — the harness's own copy of the
 *  same naming convention server/src/adapters/redis/stock.ts's stockKeyFor
 *  and orders.ts's ordersKeyFor use. */
export function stockKeyFor(saleId: string): string {
  return `stock:${saleId}:remaining`;
}

export function ordersKeyFor(saleId: string): string {
  return `orders:${saleId}:users`;
}

/** Narrow port surface — every dependency is a one-line async op, so the
 *  sequence (and its guard) is unit-testable without Redis, Mongo or Docker. */
export interface ResetPorts {
  /** Resolves with a short description when the API ANSWERS (any status), OR
   *  when the probe fails for any reason OTHER than a clean connection refusal
   *  (a timeout means wedged-but-alive, which is NOT safe to reset). Resolves
   *  null ONLY on a genuine ECONNREFUSED. */
  probeApi(): Promise<string | null>;
  setStock(value: number): Promise<void>;
  deleteOrderUsers(): Promise<void>;
  deleteCollection(name: string): Promise<void>;
}

export interface ResetResult {
  stockQuantity: number;
  cleared: readonly string[];
  /** The resolved active sale's Mongo ObjectId string — the {saleId} the
   *  namespaced keys above were built from. */
  saleId: string;
}

/** The protocol step. Guard first, then wipe — in this order, always. */
export async function resetAll(
  ports: ResetPorts,
  stockQuantity: number,
  saleId: string,
): Promise<ResetResult> {
  const serving = await ports.probeApi();
  if (serving !== null) {
    throw new ApiStillServingError(serving);
  }

  // Wipe FIRST, write the sentinel LAST. stock:{saleId}:remaining is the
  // warm/cold sentinel — a crash between the wipe and this final SET must never
  // leave a present sentinel beside a stale orders:{saleId}:users set.
  await ports.deleteOrderUsers();
  for (const name of WIPED_COLLECTIONS) {
    await ports.deleteCollection(name);
  }
  await ports.setStock(stockQuantity);

  return { stockQuantity, cleared: [ordersKeyFor(saleId), ...WIPED_COLLECTIONS], saleId };
}

/** A Node fetch() connection refusal surfaces as a TypeError whose `cause`
 *  carries `code: "ECONNREFUSED"`. A TimeoutError/AbortError (the wedged but
 *  still-bound API) is NOT a refusal. */
export function isConnectionRefused(err: unknown): boolean {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ECONNREFUSED";
}

/** GET /api/sale/status with a short timeout. Any HTTP answer means serving —
 *  and so does a TIMEOUT (a wedged-but-alive API). Only a genuine ECONNREFUSED
 *  is the green light. */
export async function probeApiUrl(apiUrl: string, timeoutMs = 2000): Promise<string | null> {
  try {
    const res = await fetch(`${apiUrl}/api/sale/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return `HTTP ${res.status} from ${apiUrl}/api/sale/status`;
  } catch (err) {
    if (isConnectionRefused(err)) {
      // Genuine ECONNREFUSED — nothing is listening on that address. Safe to proceed.
      return null;
    }
    // Timeout / abort / DNS / anything else: the API may still be alive but
    // slow. NOT safe to reset — treat it as still serving.
    const detail = err instanceof Error ? err.name || err.message : String(err);
    return `no clean refusal from ${apiUrl}/api/sale/status (${detail})`;
  }
}

export async function runReset(config: StressConfig = loadStressConfig()): Promise<ResetResult> {
  const redis = createClient({ url: config.redisUrl, disableOfflineQueue: true });
  redis.on("error", () => {});
  await redis.connect();
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });

  try {
    const db = mongoose.connection.db;
    if (db === undefined) {
      throw new Error("Mongo connection has no database handle");
    }
    // Resolve {saleId} from the seeded (never deleted) sale document, so the
    // reset targets the correct namespaced keys — the API re-upserts this
    // document at boot, so its _id is stable across resets.
    const sale = await db.collection("sales").findOne({ slug: SALE_SLUG });
    if (sale === null) {
      throw new Error(
        `no sale document with slug "${SALE_SLUG}" — the API never booted against ${config.mongodbUri}; reset needs the seeded sale to resolve {saleId}`,
      );
    }
    const saleId = String(sale._id);

    return await resetAll(
      {
        probeApi: () => probeApiUrl(config.apiUrl),
        setStock: async (value) => {
          await redis.set(stockKeyFor(saleId), String(value));
        },
        deleteOrderUsers: async () => {
          await redis.del(ordersKeyFor(saleId));
        },
        deleteCollection: async (name) => {
          await db.collection(name).deleteMany({});
        },
      },
      config.stockQuantity,
      saleId,
    );
  } finally {
    await redis.close();
    await mongoose.disconnect();
  }
}

/** `node reset.ts` entry point (also invoked in-process by run.ts). */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await runReset();
    console.log(
      `reset: ${stockKeyFor(result.saleId)} = ${result.stockQuantity}; cleared ${result.cleared.join(", ")}`,
    );
  } catch (err) {
    console.error(`reset FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
