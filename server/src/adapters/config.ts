// Env parse + fail-fast validation — the single config surface (AD-6, NFR-7).
// SALE_START_TIME / SALE_END_TIME are parsed to UTC epoch ms exactly once, here.

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface AppConfig {
  port: number;
  redisUrl: string;
  mongodbUri: string;
  stockQuantity: number;
  /** Sale window [start, end) in UTC epoch ms — the only internal time representation. */
  saleStartMs: number;
  saleEndMs: number;
  /** ISO 8601 UTC forms for wire responses (FR-1). */
  saleStartIso: string;
  saleEndIso: string;
  /** Bounded Redis connect timeout (AD-5: fail closed, never hang). */
  redisConnectTimeoutMs: number;
  /** Bounded per-command Redis timeout (AD-5: a timeout is treated as unreachable). */
  redisCommandTimeoutMs: number;
}

type Env = Record<string, string | undefined>;

function requiredIsoMs(env: Env, key: string): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") {
    throw new ConfigError(`${key} is required (ISO 8601 datetime, e.g. 2026-07-10T09:00:00Z)`);
  }
  // Require an explicit UTC offset — an offset-less value is parsed as
  // host-local time, contradicting the "normalized to UTC" contract (AD-6).
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(raw.trim())) {
    throw new ConfigError(
      `${key} must include an explicit timezone offset (Z or ±HH:MM), got: "${raw}"`,
    );
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new ConfigError(`${key} is not a valid ISO 8601 datetime: "${raw}"`);
  }
  return ms;
}

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

export function loadConfig(env: Env = process.env): AppConfig {
  const saleStartMs = requiredIsoMs(env, "SALE_START_TIME");
  const saleEndMs = requiredIsoMs(env, "SALE_END_TIME");
  if (saleEndMs <= saleStartMs) {
    throw new ConfigError("SALE_END_TIME must be strictly after SALE_START_TIME");
  }

  const stockQuantity = positiveInt(env, "STOCK_QUANTITY", 100);
  const port = positiveInt(env, "PORT", 3000);
  if (port > 65535) {
    throw new ConfigError(`PORT must be <= 65535, got: ${port}`);
  }

  return {
    port,
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    mongodbUri: env.MONGODB_URI ?? "mongodb://localhost:27017/flash-sale",
    stockQuantity,
    saleStartMs,
    saleEndMs,
    saleStartIso: new Date(saleStartMs).toISOString(),
    saleEndIso: new Date(saleEndMs).toISOString(),
    redisConnectTimeoutMs: 2000,
    redisCommandTimeoutMs: 1000,
  };
}
