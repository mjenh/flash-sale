// Shared init used by both the server entrypoint and integration tests.
// Boot order, strictly before listen():
//   config -> Redis connect -> Mongo connect -> Lua script registration ->
//   seed upserts + warm/cold reconcile -> sale-events init (publisher +
//   broadcaster + subscriber on a dedicated connection + window timers) ->
//   app. Teardown unwinds in reverse.
import { pino, type Logger } from "pino";
import type { Express } from "express";
import { ConfigError, loadConfig, type AppConfig } from "./adapters/config.ts";
import { createRedisClient, type RedisClient } from "./adapters/redis/client.ts";
import { createStockStore } from "./adapters/redis/stock.ts";
import { createOrderStore } from "./adapters/redis/orders.ts";
import { createReconciler } from "./adapters/redis/reconcile.ts";
import { createEventPublisher, createSaleEventsSubscription } from "./adapters/redis/events.ts";
import { connectMongo, disconnectMongo } from "./adapters/mongo/client.ts";
import { createOrderRecorder, mongoAuditModelOps, type AuditModelOps } from "./adapters/mongo/audit.ts";
import { createDomainSeeder, mongoSeedModelOps, SALE_SLUG, type SeedModelOps } from "./adapters/mongo/seed.ts";
import { noopPaymentProvider } from "./adapters/payment/noop.ts";
import { createSaleStatusService, type StockReader } from "./services/sale-status.ts";
import { armWindowTimers, createSaleEventsBroadcaster } from "./services/sale-events.ts";
import { createOrderService, type OrderAttemptPort, type OrderEventsPort } from "./services/order.ts";
import type { PaymentProvider } from "./services/payment.ts";
import { systemClock, type Clock } from "./services/clock.ts";
import { createSaleResolver, type SaleLookupOps, type SaleSummary } from "./middleware/sale-resolver.ts";
import { createApiRouter } from "./routes/index.ts";
import { createApp } from "./app.ts";

export interface BootstrapOverrides {
  env?: Record<string, string | undefined>;
  logger?: Logger;
  /** Injection seam — integration tests pin the window state. */
  clock?: Clock;
  createRedis?: (config: AppConfig, onError: (err: Error) => void) => RedisClient;
  connectRedis?: (client: RedisClient) => Promise<void>;
  disconnectRedis?: (client: RedisClient) => Promise<void>;
  connectMongoDb?: (uri: string) => Promise<unknown>;
  disconnectMongoDb?: () => Promise<void>;
  /** Test seams — tests run the real recorder/seeder over fake model ops. */
  mongoModelOps?: { audit: AuditModelOps; seed: SeedModelOps };
  payment?: PaymentProvider;
  /** Dedicated subscriber connection for sale:events pub/sub. */
  duplicateRedis?: (client: RedisClient) => RedisClient;
  /** Test seam for the sale resolution middleware's lookup operations.
   *  When omitted, ops are derived from the boot-seeded sale data. */
  saleLookupOps?: SaleLookupOps;
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

  // 2. Redis (bounded connect timeout; offline queue disabled).
  const createRedis =
    overrides.createRedis ?? ((cfg, onError) => createRedisClient(cfg, onError));
  const redis = createRedis(config, (err) => logger.error({ err }, "redis error"));
  const connectRedis =
    overrides.connectRedis ??
    (async (client: RedisClient) => {
      // node-redis retries forever by design; boot must fail fast instead.
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

  // Lua order script registration — SCRIPT LOAD + sha cache, strictly before
  // listen(); attempt() falls back to EVAL on NOSCRIPT.
  const orderStore = createOrderStore(redis, {
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });
  await orderStore.register();

  // Durable audit + restart safety, strictly before listen():
  // idempotent seed upserts, then the warm/cold gate on stock:{saleId}:remaining.
  const mongoOps = overrides.mongoModelOps ?? { audit: mongoAuditModelOps, seed: mongoSeedModelOps };
  const seeder = createDomainSeeder(mongoOps.seed);
  const saleRefs = await seeder.seed(config);
  // Story 4.2: Redis keys/channel are namespaced by saleId — the resolved
  // Sale's Mongo ObjectId string (req.sale._id per the sale-resolver
  // middleware). v1.0 handlers (routes/sale.ts, routes/order.ts) don't yet
  // read req.sale (that's Story 4.4's job), so this boot-resolved saleId is
  // the interim "the one sale" identity threaded into the adapters below.
  // The v1.0 flat keys (stock:remaining, orders:users, sale:events) are no
  // longer written or read by the live request path; Story 4.6 owns
  // migrating any surviving flat-key data from a pre-4.2 deployment.
  const saleId = saleRefs.saleId;
  const reconciler = createReconciler(redis, {
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });
  if (await reconciler.hasStockKey(saleId)) {
    // Warm start: surviving Redis state is authoritative — touch nothing.
    // A changed STOCK_QUANTITY against surviving state is thereby a no-op;
    // a sale reset happens only via the explicit offline reset script.
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
    await reconciler.rebuild(emails, remaining, saleId);
    logger.info(
      { confirmedOrders: emails.length, remaining },
      "cold start: rebuilt Redis order state from MongoDB",
    );
  }
  const stockStore = createStockStore(redis, {
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });
  // Bind the boot-resolved saleId into the narrower StockReader port the
  // sale-status service expects — keeps that service framework-free and
  // saleId-agnostic (Story 4.4 will make this per-request).
  const stockReader: StockReader = {
    getRemaining: () => stockStore.getRemaining(saleId),
  };

  // Shared clock + window + status service: the same instances feed
  // HTTP, the order service, and the SSE broadcaster.
  const clock = overrides.clock ?? systemClock;
  const window = {
    startMs: config.saleStartMs,
    endMs: config.saleEndMs,
    startIso: config.saleStartIso,
    endIso: config.saleEndIso,
  };
  const saleStatus = createSaleStatusService({ clock, stock: stockReader, window });

  // Sale-events realtime layer: PUBLISH rides the main client; SUBSCRIBE runs
  // on a dedicated duplicated connection; boot arms window timers for FUTURE
  // boundaries only. Subscriber failure here rejects bootstrap() — fail-fast
  // strictly before listen().
  const eventPublisher = createEventPublisher(redis, {
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });
  const saleEvents = createSaleEventsBroadcaster({
    saleStatus,
    clock,
    reportBroadcastFailure: (err) => {
      logger.error({ err }, "sse broadcast failed; closing open streams");
    },
  });
  const duplicateRedis = overrides.duplicateRedis ?? ((client: RedisClient) => client.duplicate());
  const subscription = await createSaleEventsSubscription(duplicateRedis(redis), {
    saleId,
    onEvent: (event) => {
      saleEvents.onDomainEvent(event);
    },
    onConnectionLost: (err) => {
      logger.error({ err }, "sale:{saleId}:events subscriber connection lost; closing open streams");
      saleEvents.closeAll();
    },
    connectTimeoutMs: config.redisConnectTimeoutMs * 5,
  });
  const windowTimers = armWindowTimers({
    clock,
    startMs: config.saleStartMs,
    endMs: config.saleEndMs,
    publish: (event) => eventPublisher.publish(event, saleId),
    onPublishFailure: (err) => {
      logger.error({ err }, "window-boundary event publish failed (logged, never thrown)");
    },
  });

  // 4. Sale resolution middleware — slug -> Sale doc with in-memory cache.
  // Boot validation: the slug "active" is reserved for the discovery endpoint.
  if ((SALE_SLUG as string) === "active") {
    throw new ConfigError('The slug "active" is reserved for the discovery endpoint and cannot be used as a sale slug.');
  }
  // Single-sale ops derived from boot-seeded data. A later story (4.3+) will
  // replace this with a Mongoose-backed implementation for true multi-sale.
  const seededSale: SaleSummary = {
    _id: saleRefs.saleId,
    slug: SALE_SLUG,
    startTime: new Date(config.saleStartMs),
    endTime: new Date(config.saleEndMs),
    stockQuantity: config.stockQuantity,
  };
  const defaultSaleLookupOps: SaleLookupOps = {
    async findBySlug(slug: string): Promise<SaleSummary | null> {
      return slug === seededSale.slug ? seededSale : null;
    },
    async findActiveSale(): Promise<SaleSummary | null> {
      return seededSale;
    },
  };
  const saleResolver = createSaleResolver({
    ops: overrides.saleLookupOps ?? defaultSaleLookupOps,
    clock,
  });

  // 5. App assembly.
  // Bind the boot-resolved saleId into the narrower ports createOrderService
  // expects — the order service itself stays framework-free and saleId-
  // agnostic (Story 4.4 threads req.sale through per-request instead).
  const orderAttemptPort: OrderAttemptPort = {
    attempt: (email) => orderStore.attempt(saleId, email),
    hasOrdered: (email) => orderStore.hasOrdered(saleId, email),
  };
  const orderEventsPort: OrderEventsPort = {
    publish: (event) => eventPublisher.publish(event, saleId),
  };
  const orderService = createOrderService({
    clock,
    window,
    orders: orderAttemptPort,
    audit: createOrderRecorder(saleRefs, mongoOps.audit),
    payment: overrides.payment ?? noopPaymentProvider,
    events: orderEventsPort,
    reportSideEffectFailure: (effect, err) => {
      logger.error({ err, effect }, "post-accept side effect failed (never alters the HTTP outcome)");
    },
  });
  const app = createApp({
    logger,
    apiRouter: createApiRouter({ saleStatus, saleEvents, orderService, saleResolver }),
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
