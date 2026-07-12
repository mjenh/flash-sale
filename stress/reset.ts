// The reset contract (ARCHITECTURE-SPINE "Reset contract"), made mechanical.
//
// Runs ONLY while the API is stopped: while the API serves, the AD-1 Lua script
// is the sole writer of `stock:remaining` and `orders:users`, and a concurrent
// SET here could hand a buyer a 201 against stock that no longer exists.
// The guard below treats ANY answer from the API — including a 503 — as
// "still serving". Only a refused connection is the green light.
//
// Wipes: SET stock:remaining = STOCK_QUANTITY, DEL orders:users,
//        deleteMany({}) on orders, orderlines, users.
// Never touches the seed collections (products, sales, saleproducts,
// inventories) — the API re-upserts them at boot, and deleting `sales` would
// mint a fresh saleId and silently orphan the verifier's join.
import { createClient } from "redis";
import mongoose from "mongoose";
import { loadStressConfig, type StressConfig } from "./config.ts";

export class ApiStillServingError extends Error {
  override name = "ApiStillServingError";
  constructor(detail: string) {
    super(`The API is still serving (${detail}). Stop it before resetting — while it serves, the Lua script is the sole writer of the sale state (AD-1).`);
  }
}

/** The wiped collections, in order. Seed collections are absent by design. */
export const WIPED_COLLECTIONS = ["orders", "orderlines", "users"] as const;

export const STOCK_KEY = "stock:remaining";
export const ORDERS_KEY = "orders:users";

/** Narrow port surface — every dependency is a one-line async op, so the
 *  sequence (and its guard) is unit-testable without Redis, Mongo or Docker. */
export interface ResetPorts {
  /** Resolves with a short description when the API ANSWERS (any status);
   *  resolves null when the connection is refused / times out. */
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

  await ports.setStock(stockQuantity);
  await ports.deleteOrderUsers();
  for (const name of WIPED_COLLECTIONS) {
    await ports.deleteCollection(name);
  }

  return { stockQuantity, cleared: [ORDERS_KEY, ...WIPED_COLLECTIONS] };
}

/** GET /api/sale/status with a short timeout. Any HTTP answer means serving. */
export async function probeApiUrl(apiUrl: string, timeoutMs = 2000): Promise<string | null> {
  try {
    const res = await fetch(`${apiUrl}/api/sale/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return `HTTP ${res.status} from ${apiUrl}/api/sale/status`;
  } catch {
    // Refused / DNS failure / timeout — nothing is listening. Safe to reset.
    return null;
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
