// Shared init used by index.ts AND (from Story 1.2 on) integration tests —
// tests never re-implement boot. Order, strictly before listen():
//   config (fail fast, AD-6) -> Redis connect (AD-5) -> Mongo connect ->
//   Lua order-script registration (AD-1, Story 1.3) -> app.
// Reserved slots: AD-4 seed + cold-start rebuild (Story 1.4), sale-events
// subscriber + timers (Story 1.6).
import { pino, type Logger } from "pino";
import type { Express } from "express";
import { loadConfig, type AppConfig } from "./adapters/config.ts";
import { createRedisClient, type RedisClient } from "./adapters/redis/client.ts";
import { createStockStore } from "./adapters/redis/stock.ts";
import { createOrderStore } from "./adapters/redis/orders.ts";
import { connectMongo, disconnectMongo } from "./adapters/mongo/client.ts";
import { createSaleStatusService } from "./services/sale-status.ts";
import { createOrderService } from "./services/order.ts";
import { systemClock, type Clock } from "./services/clock.ts";
import { createApiRouter } from "./routes/index.ts";
import { createApp } from "./app.ts";

export interface BootstrapOverrides {
  env?: Record<string, string | undefined>;
  logger?: Logger;
  /** AD-6 injection seam — integration tests pin the window state. */
  clock?: Clock;
  createRedis?: (config: AppConfig, onError: (err: Error) => void) => RedisClient;
  connectRedis?: (client: RedisClient) => Promise<void>;
  disconnectRedis?: (client: RedisClient) => Promise<void>;
  connectMongoDb?: (uri: string) => Promise<unknown>;
  disconnectMongoDb?: () => Promise<void>;
}

export interface BootstrapResult {
  app: Express;
  config: AppConfig;
  logger: Logger;
  redis: RedisClient;
  teardown: () => Promise<void>;
}

export async function bootstrap(overrides: BootstrapOverrides = {}): Promise<BootstrapResult> {
  const env = overrides.env ?? process.env;

  // 1. Config first — invalid config must fail before any connection or listen().
  const config = loadConfig(env);
  const logger = overrides.logger ?? pino();

  // 2. Redis (bounded connect timeout; offline queue disabled — AD-5).
  const createRedis =
    overrides.createRedis ?? ((cfg, onError) => createRedisClient(cfg, onError));
  const redis = createRedis(config, (err) => logger.error({ err }, "redis error"));
  const connectRedis =
    overrides.connectRedis ??
    (async (client: RedisClient) => {
      // node-redis retries forever by design; boot must fail fast instead (AD-5/AD-6).
      const bootTimeoutMs = config.redisConnectTimeoutMs * 5;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          client.connect(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Redis not reachable within ${bootTimeoutMs} ms at ${config.redisUrl}`));
            }, bootTimeoutMs);
          }),
        ]);
      } catch (err) {
        client.destroy();
        throw err;
      } finally {
        clearTimeout(timer);
      }
    });
  await connectRedis(redis);

  // 3. Mongo.
  await (overrides.connectMongoDb ?? connectMongo)(config.mongodbUri);

  // AD-1 Lua order script registration (Story 1.3) — SCRIPT LOAD + sha cache,
  // strictly before listen(); attempt() falls back to EVAL on NOSCRIPT.
  const orderStore = createOrderStore(redis, {
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });
  await orderStore.register();
  // Interim cold-Redis seed (Story 1.2) — SETNX only, strictly before listen();
  // replaced by the full AD-4 seed upserts + cold-start rebuild in Story 1.4.
  const stockStore = createStockStore(redis, {
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });
  await stockStore.seedIfAbsent(config.stockQuantity);
  // (Story 1.6) sale-events subscriber (duplicated connection) + window timers here.

  // 4. App assembly.
  const clock = overrides.clock ?? systemClock;
  const window = {
    startMs: config.saleStartMs,
    endMs: config.saleEndMs,
    startIso: config.saleStartIso,
    endIso: config.saleEndIso,
  };
  const saleStatus = createSaleStatusService({ clock, stock: stockStore, window });
  const orderService = createOrderService({ clock, window, orders: orderStore });
  const app = createApp({
    logger,
    apiRouter: createApiRouter({ saleStatus, orderService }),
    clientDistDir: env.CLIENT_DIST_DIR,
  });

  const disconnectRedis =
    overrides.disconnectRedis ??
    (async (client: RedisClient) => {
      if (client.isOpen) {
        await client.close();
      }
    });

  const teardown = async (): Promise<void> => {
    await (overrides.disconnectMongoDb ?? disconnectMongo)();
    await disconnectRedis(redis);
  };

  return { app, config, logger, redis, teardown };
}
