// Shared init used by index.ts AND (from Story 1.2 on) integration tests —
// tests never re-implement boot. Order, strictly before listen():
//   config (fail fast, AD-6) -> Redis connect (AD-5) -> Mongo connect ->
//   Lua order-script registration (AD-1, Story 1.3) ->
//   AD-4 seed upserts + warm/cold reconcile (Story 1.4) ->
//   sale-events init (Story 1.6, AD-9): publisher + broadcaster + subscriber
//   on a dedicated duplicated connection + future-boundary window timers ->
//   app. Teardown unwinds in reverse (timers, broadcaster, subscriber, stores).
import { pino, type Logger } from "pino";
import type { Express } from "express";
import { loadConfig, type AppConfig } from "./adapters/config.ts";
import { createRedisClient, type RedisClient } from "./adapters/redis/client.ts";
import { createStockStore } from "./adapters/redis/stock.ts";
import { createOrderStore } from "./adapters/redis/orders.ts";
import { createReconciler } from "./adapters/redis/reconcile.ts";
import { createEventPublisher, createSaleEventsSubscription } from "./adapters/redis/events.ts";
import { connectMongo, disconnectMongo } from "./adapters/mongo/client.ts";
import { createOrderRecorder, mongoAuditModelOps, type AuditModelOps } from "./adapters/mongo/audit.ts";
import { createDomainSeeder, mongoSeedModelOps, type SeedModelOps } from "./adapters/mongo/seed.ts";
import { noopPaymentProvider } from "./adapters/payment/noop.ts";
import { createSaleStatusService } from "./services/sale-status.ts";
import { armWindowTimers, createSaleEventsBroadcaster } from "./services/sale-events.ts";
import { createOrderService } from "./services/order.ts";
import type { PaymentProvider } from "./services/payment.ts";
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
  /** Story 1.4 seams — tests run the REAL recorder/seeder over fake model ops. */
  mongoModelOps?: { audit: AuditModelOps; seed: SeedModelOps };
  payment?: PaymentProvider;
  /** Story 1.6 seam — the dedicated sale:events subscriber connection (AD-9). */
  duplicateRedis?: (client: RedisClient) => RedisClient;
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

  // AD-4 durable audit + restart safety (Story 1.4), strictly before listen():
  // idempotent seed upserts, then the warm/cold gate on stock:remaining.
  const mongoOps = overrides.mongoModelOps ?? { audit: mongoAuditModelOps, seed: mongoSeedModelOps };
  const seeder = createDomainSeeder(mongoOps.seed);
  const saleRefs = await seeder.seed(config);
  const reconciler = createReconciler(redis, {
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });
  if (await reconciler.hasStockKey()) {
    // Warm start: surviving Redis state is authoritative — touch nothing.
    // A changed STOCK_QUANTITY against surviving state is thereby a no-op;
    // a sale reset happens only via the explicit offline reset script (AD-4).
  } else {
    // Cold start: rebuild Redis FROM MongoDB truth — never the reverse.
    const emails = await seeder.listConfirmedOrderEmails(saleRefs.saleId);
    const remaining = Math.max(0, config.stockQuantity - emails.length);
    if (config.stockQuantity - emails.length < 0) {
      logger.warn(
        { stockQuantity: config.stockQuantity, confirmedOrders: emails.length },
        "cold rebuild: confirmed orders exceed STOCK_QUANTITY; clamping stock:remaining to 0",
      );
    }
    await reconciler.rebuild(emails, remaining);
    logger.info(
      { confirmedOrders: emails.length, remaining },
      "cold start: rebuilt Redis order state from MongoDB (AD-4)",
    );
  }
  const stockStore = createStockStore(redis, {
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });

  // Shared clock + window + status service (AD-6): the same instances feed
  // HTTP, the order service, and the SSE broadcaster (AD-9's single composer).
  const clock = overrides.clock ?? systemClock;
  const window = {
    startMs: config.saleStartMs,
    endMs: config.saleEndMs,
    startIso: config.saleStartIso,
    endIso: config.saleEndIso,
  };
  const saleStatus = createSaleStatusService({ clock, stock: stockStore, window });

  // Sale-events realtime layer (Story 1.6, AD-9): PUBLISH rides the main
  // client; SUBSCRIBE runs on a dedicated duplicated connection; boot arms
  // window timers for FUTURE boundaries only. Subscriber failure here rejects
  // bootstrap() — fail-fast strictly before listen() (AD-5).
  const eventPublisher = createEventPublisher(redis, {
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });
  const saleEvents = createSaleEventsBroadcaster({
    saleStatus,
    clock,
    reportBroadcastFailure: (err) => {
      logger.error({ err }, "sse broadcast failed; closing open streams (AD-5)");
    },
  });
  const duplicateRedis = overrides.duplicateRedis ?? ((client: RedisClient) => client.duplicate());
  const subscription = await createSaleEventsSubscription(duplicateRedis(redis), {
    onEvent: (event) => {
      saleEvents.onDomainEvent(event);
    },
    onConnectionLost: (err) => {
      logger.error({ err }, "sale:events subscriber connection lost; closing open streams (AD-5)");
      saleEvents.closeAll();
    },
    connectTimeoutMs: config.redisConnectTimeoutMs * 5,
  });
  const windowTimers = armWindowTimers({
    clock,
    startMs: config.saleStartMs,
    endMs: config.saleEndMs,
    publish: (event) => eventPublisher.publish(event),
    onPublishFailure: (err) => {
      logger.error({ err }, "window-boundary event publish failed (AD-9: logged, never thrown)");
    },
  });

  // 4. App assembly.
  const orderService = createOrderService({
    clock,
    window,
    orders: orderStore,
    audit: createOrderRecorder(saleRefs, mongoOps.audit),
    payment: overrides.payment ?? noopPaymentProvider,
    events: eventPublisher,
    reportSideEffectFailure: (effect, err) => {
      logger.error({ err, effect }, "post-accept side effect failed (never alters the HTTP outcome)");
    },
  });
  const app = createApp({
    logger,
    apiRouter: createApiRouter({ saleStatus, saleEvents, orderService }),
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
    windowTimers.cancel();
    saleEvents.stop();
    await subscription.close();
    await (overrides.disconnectMongoDb ?? disconnectMongo)();
    await disconnectRedis(redis);
  };

  return { app, config, logger, redis, teardown };
}
