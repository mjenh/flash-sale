// Env parse + fail-fast validation (ARCHITECTURE-SPINE: adapters/config).
// Extend with SALE_START_TIME / SALE_END_TIME / STOCK_QUANTITY as stories land.

export interface Config {
  port: number;
  redisUrl: string;
  mongoUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  const redisUrl = env.REDIS_URL ?? "redis://localhost:6379";
  const mongoUrl = env.MONGO_URL ?? "mongodb://localhost:27017/flash-sale";

  return { port, redisUrl, mongoUrl };
}
