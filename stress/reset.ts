// The reset contract (ARCHITECTURE-SPINE "Reset contract"), made mechanical.
//
// Runs ONLY while the API is stopped: while the API serves, the Lua script
// is the sole writer of `stock:remaining` and `orders:users`, and a concurrent
// SET here could hand a buyer a 201 against stock that no longer exists.
// The guard below treats ANY answer from the API — including a 503 — as
// "still serving", and also treats a probe that TIMES OUT (a wedged-but-alive
// API) as still serving. Only a genuine connection refusal (ECONNREFUSED) is
// the green light.
//
// Wipes, in crash-safe order (the sentinel is written LAST):
//   DEL orders:users, deleteMany({}) on orders, orderlines, users,
//   then SET stock:remaining = STOCK_QUANTITY.
// stock:remaining IS the warm/cold sentinel (server/src/adapters/redis/
// reconcile.ts writes DEL → SADD → SET) — writing it last means a crash
// mid-reset leaves no sentinel beside a stale orders:users set, so the API's
// boot rebuild re-runs the cold path.
// Never touches the seed collections (products, sales, saleproducts,
// inventories) — the API re-upserts them at boot, and deleting `sales` would
// mint a fresh saleId and silently orphan the verifier's join.
import { createClient } from "redis";
import mongoose from "mongoose";
import { loadStressConfig, type StressConfig } from "./config.ts";

export class ApiStillServingError extends Error {
  override name = "ApiStillServingError";
  constructor(detail: string) {
    super(`The API is still serving (${detail}). Stop it before resetting — while it serves, the Lua script is the sole writer of the sale state.`);
  }
}

/** The wiped collections, in order. Seed collections are absent by design. */
export const WIPED_COLLECTIONS = ["orders", "orderlines", "users"] as const;

export const STOCK_KEY = "stock:remaining";
export const ORDERS_KEY = "orders:users";

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
}

/** The protocol step. Guard first, then wipe — in this order, always. */
export async function resetAll(ports: ResetPorts, stockQuantity: number): Promise<ResetResult> {
  const serving = await ports.probeApi();
  if (serving !== null) {
    throw new ApiStillServingError(serving);
  }

  // Wipe FIRST, write the sentinel LAST. stock:remaining is the
  // warm/cold sentinel — a crash between the wipe and this final SET must never
  // leave a present sentinel beside a stale orders:users set.
  await ports.deleteOrderUsers();
  for (const name of WIPED_COLLECTIONS) {
    await ports.deleteCollection(name);
  }
  await ports.setStock(stockQuantity);

  return { stockQuantity, cleared: [ORDERS_KEY, ...WIPED_COLLECTIONS] };
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
      return null; // genuinely refused — nothing is listening. Safe to reset.
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
    return await resetAll(
      {
        probeApi: () => probeApiUrl(config.apiUrl),
        setStock: async (value) => {
          await redis.set(STOCK_KEY, String(value));
        },
        deleteOrderUsers: async () => {
          await redis.del(ORDERS_KEY);
        },
        deleteCollection: async (name) => {
          await db.collection(name).deleteMany({});
        },
      },
      config.stockQuantity,
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
      `reset: ${STOCK_KEY} = ${result.stockQuantity}; cleared ${result.cleared.join(", ")}`,
    );
  } catch (err) {
    console.error(`reset FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
