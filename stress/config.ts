// The harness's single env surface — parsed and validated once, fail-fast
// (the same discipline as server/src/adapters/config.ts, deliberately NOT
// imported from it: the harness is an independent observer of the deployed
// stack and must never share code with the system it is judging).

export class StressConfigError extends Error {
  override name = "StressConfigError";
}

/** Must match server/src/adapters/mongo/seed.ts (SALE_SLUG). The verifier
 *  resolves the sale by this slug and hard-fails when it is absent — that
 *  failure IS the divergence alarm (workspaces cannot import each other). */
export const SALE_SLUG = "flash-sale";

export interface StressConfig {
  /** Base URL of the API under test (no trailing slash). */
  apiUrl: string;
  redisUrl: string;
  mongodbUri: string;
  /** Units on sale — the STOCK_QUANTITY the API booted with. */
  stockQuantity: number;
  /** Unique emails the primary k6 scenario fires. */
  attempts: number;
  /** k6 virtual users for the burst. VUs != attempts. */
  vus: number;
  /** Enable the optional retry scenario (200 becomes an allowed status). */
  retry: boolean;
}

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new StressConfigError(`${key} must be a positive integer, got: "${raw}"`);
  }
  return n;
}

function url(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  const value = raw === undefined || raw.trim() === "" ? fallback : raw.trim();
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function loadStressConfig(env: Env = process.env): StressConfig {
  const stockQuantity = positiveInt(env, "STOCK_QUANTITY", 100);
  const attempts = positiveInt(env, "ATTEMPTS", 5000);
  const vus = positiveInt(env, "VUS", 500);
  if (vus > attempts) {
    throw new StressConfigError(`VUS (${vus}) must not exceed ATTEMPTS (${attempts})`);
  }

  return {
    apiUrl: url(env, "API_URL", "http://localhost:3000"),
    redisUrl: url(env, "REDIS_URL", "redis://localhost:6379"),
    mongodbUri: url(env, "MONGODB_URI", "mongodb://localhost:27017/flash-sale"),
    stockQuantity,
    attempts,
    vus,
    retry: env.RETRY === "1" || env.RETRY === "true",
  };
}
