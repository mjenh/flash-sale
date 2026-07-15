// Env parse + fail-fast validation for infrastructure config only.
// Sale timing, stock quantity, slugs, names, and pricing are now read from
// MongoDB at boot (see adapters/mongo/sale-bootstrap.ts) — not derived from
// env vars. This file validates only the env vars that can't come from the DB:
// network addresses, ports, and timeout budgets.
import { hostname } from "node:os";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface AppConfig {
  port: number;
  redisUrl: string;
  mongodbUri: string;
  /** Bounded Redis connect timeout — fail closed, never hang. */
  redisConnectTimeoutMs: number;
  /** Bounded per-command Redis timeout — a timeout is treated as unreachable. */
  redisCommandTimeoutMs: number;
  /** Max reconnect backoff cap in ms (reconnectStrategy ceiling). */
  redisReconnectMaxMs: number;
  /** MongoDB driver timeout for replica-set election / Atlas selection. */
  mongoSelectionTimeoutMs: number;
  /** Express JSON body size limit (e.g. "8kb"). */
  httpBodyLimit: string;
  /** Sale-resolver slug→sale in-memory cache TTL in ms (max 60 000). */
  saleResolverCacheTtlMs: number;
}

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ConfigError(`${key} must be a positive integer, got: "${raw}"`);
  }
  return n;
}

/** Minimal config for the standalone worker process.
 *  Sale window and stock are irrelevant to the worker — it only drains the
 *  queue:orders stream into MongoDB. */
export interface WorkerConfig {
  redisUrl: string;
  mongodbUri: string;
  redisConnectTimeoutMs: number;
  redisCommandTimeoutMs: number;
  redisReconnectMaxMs: number;
  /** Unique consumer name for XREADGROUP. Each replica must use a distinct
   *  value so PEL re-delivery is scoped per-instance (finding #7).
   *  Defaults to WORKER_CONSUMER_ID env var, or "worker-<hostname>" if unset. */
  workerConsumerId: string;
  /** Consumer group name shared by all workers draining the same stream.
   *  Override when running independent consumer groups against the same
   *  stream. Defaults to WORKER_GROUP ("workers"). */
  workerGroup: string;
}

export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  return {
    redisUrl: env["REDIS_URL"] ?? "redis://localhost:6379",
    mongodbUri: env["MONGODB_URI"] ?? "mongodb://localhost:27017/flash-sale",
    redisConnectTimeoutMs: positiveInt(env, "REDIS_CONNECT_TIMEOUT_MS", 2000),
    redisCommandTimeoutMs: positiveInt(env, "REDIS_COMMAND_TIMEOUT_MS", 1000),
    redisReconnectMaxMs: positiveInt(env, "REDIS_RECONNECT_MAX_MS", 2000),
    workerConsumerId: env["WORKER_CONSUMER_ID"]?.trim() || `worker-${hostname()}`,
    workerGroup: env["WORKER_GROUP"]?.trim() || "workers",
  };
}

export function loadConfig(env: Env = process.env): AppConfig {
  const port = positiveInt(env, "PORT", 3000);
  if (port > 65535) {
    throw new ConfigError(`PORT must be <= 65535, got: ${port}`);
  }

  const saleResolverCacheTtlMs = positiveInt(env, "SALE_RESOLVER_CACHE_TTL_MS", 60_000);
  if (saleResolverCacheTtlMs > 60_000) {
    throw new ConfigError(
      `SALE_RESOLVER_CACHE_TTL_MS must be <= 60000, got: ${saleResolverCacheTtlMs}`,
    );
  }

  return {
    port,
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    mongodbUri: env.MONGODB_URI ?? "mongodb://localhost:27017/flash-sale",
    redisConnectTimeoutMs: positiveInt(env, "REDIS_CONNECT_TIMEOUT_MS", 2000),
    redisCommandTimeoutMs: positiveInt(env, "REDIS_COMMAND_TIMEOUT_MS", 1000),
    redisReconnectMaxMs: positiveInt(env, "REDIS_RECONNECT_MAX_MS", 2000),
    mongoSelectionTimeoutMs: positiveInt(env, "MONGO_SELECTION_TIMEOUT_MS", 5000),
    httpBodyLimit: env.HTTP_BODY_LIMIT?.trim() || "8kb",
    saleResolverCacheTtlMs,
  };
}
