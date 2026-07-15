// Shared init used by both the server entrypoint and integration tests.
// Boot order, strictly before listen():
//   config -> Redis connect -> Mongo connect -> Lua script registration ->
//   DB reads (listAllSales → selectActiveSale → getSaleProduct) +
//   warm/cold reconcile -> sale-events init (publisher + broadcaster +
//   subscriber on a dedicated connection + window timers) -> app.
// Teardown unwinds in reverse.
import { pino, type Logger } from "pino";
import type { Express } from "express";
import { ConfigError, loadConfig, type AppConfig } from "./adapters/config.ts";
import { createRedisClient, type RedisClient } from "./adapters/redis/client.ts";
import { createStockStore } from "./adapters/redis/stock.ts";
import { createOrderStore } from "./adapters/redis/orders.ts";
import { createReconciler } from "./adapters/redis/reconcile.ts";
import { createFlatKeyMigrator } from "./adapters/redis/migrate.ts";
import { createEventPublisher, createSaleEventsSubscription } from "./adapters/redis/events.ts";
import { connectMongo, disconnectMongo } from "./adapters/mongo/client.ts";
import { createOrderRecorder, mongoAuditModelOps, type AuditModelOps } from "./adapters/mongo/audit.ts";
import { createOrderQueueProducer, createQueueAuditAdapter } from "./adapters/redis/order-queue.ts";
import {
  mongoSaleBootstrapOps,
  type SaleBootstrapOps,
} from "./adapters/mongo/sale-bootstrap.ts";
import { createCatalogReader, mongoCatalogModelOps, type CatalogModelOps } from "./adapters/mongo/catalog.ts";
import { noopPaymentProvider } from "./adapters/payment/noop.ts";
import { createSaleStatusService, type SaleWindow } from "./services/sale-status.ts";
import { armWindowTimers, createSaleEventsBroadcaster } from "./services/sale-events.ts";
import { createOrderService, type OrderAttemptPort, type OrderEventsPort } from "./services/order.ts";
import type { PaymentProvider } from "./services/payment.ts";
import { systemClock, type Clock } from "./services/clock.ts";
import {
  createSaleResolver,
  isSaleActiveAt,
  selectActiveSale,
  windowFromSale,
  type SaleLookupOps,
  type SaleSummary,
} from "./middleware/sale-resolver.ts";
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
  /** Test seam for reading sale/product config from the DB.
   *  When provided directly, takes precedence over mongoModelOps.saleBootstrap. */
  saleBootstrapOps?: SaleBootstrapOps;
  /** Test seams — tests run the real recorder/catalog reader over fake model ops.
   *  saleBootstrap is optional here for backward compat: if mongoModelOps is the
   *  primary override path, bootstrap also checks mongoModelOps.saleBootstrap
   *  before falling back to mongoSaleBootstrapOps. */
  mongoModelOps?: { audit: AuditModelOps; saleBootstrap?: SaleBootstrapOps; catalog: CatalogModelOps };
  /** Override the order audit adapter — factory receives the boot-resolved productId and
   *  flashSalePrice so tests that need immediate Mongo writes can inject
   *  createOrderRecorder(productId, flashSalePrice, ops) directly instead of the
   *  default write-behind queue adapter. */
  createOrderAudit?: (productId: string, flashSalePrice: number) => import("./services/order.ts").OrderAuditPort;
  payment?: PaymentProvider;
  /** Dedicated subscriber connection for sale:events pub/sub. */
  duplicateRedis?: (client: RedisClient) => RedisClient;
  /** Test seam for the sale resolution middleware's lookup operations.
   *  When omitted, ops are derived from the boot-resolved sale data. */
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
  await (overrides.connectMongoDb ?? ((uri: string) => connectMongo(uri, config.mongoSelectionTimeoutMs)))(config.mongodbUri);

  // Lua order script registration — SCRIPT LOAD + sha cache, strictly before
  // listen(); attempt() falls back to EVAL on NOSCRIPT.
  const orderStore = createOrderStore(redis, {
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });
  await orderStore.register();

  // Resolve model ops: audit and catalog use mongoModelOps seam; saleBootstrap
  // has its own dedicated seam (saleBootstrapOps) that takes precedence, with
  // mongoModelOps.saleBootstrap as the legacy backward-compat path for tests.
  const mongoOps = overrides.mongoModelOps ?? {
    audit: mongoAuditModelOps,
    catalog: mongoCatalogModelOps,
  };
  const saleBootstrap: SaleBootstrapOps =
    overrides.saleBootstrapOps ??
    overrides.mongoModelOps?.saleBootstrap ??
    mongoSaleBootstrapOps;

  // Shared clock: the same instance feeds HTTP, the order service, and the
  // SSE broadcaster/timers.
  const clock = overrides.clock ?? systemClock;

  // 4. DB reads: list all sales, select the active one, get its product.
  //    Fail fast if no sale or no product is found — the server has no valid
  //    state to serve and should not silently start.
  const nowMsAtBoot = clock();
  const allSales = await saleBootstrap.listAllSales();

  // v1.1-NFR-5: at most one sale may have a [startTime, endTime) window
  // covering now() at any given moment.
  const currentlyActiveSales = allSales.filter((sale) => isSaleActiveAt(sale as SaleSummary, nowMsAtBoot));
  if (currentlyActiveSales.length > 1) {
    throw new ConfigError("Multiple active sales detected. Only one sale may be active at a time.");
  }

  // Priority: within window > nearest upcoming > most recently ended — the
  // same forgiving priority as sale-resolver.ts's findActive(), so boot
  // reconciliation and the discovery endpoint never disagree about "the"
  // active sale.
  const activeSale = selectActiveSale(allSales as SaleSummary[], nowMsAtBoot);
  if (activeSale === null) {
    throw new ConfigError(
      "No sale found in the database. Provision a sale via db/scripts/seed-db.ts before starting the server.",
    );
  }

  const saleProduct = await saleBootstrap.getSaleProduct(activeSale._id);
  if (saleProduct === null) {
    throw new ConfigError(
      `No product configured for sale "${activeSale.slug}" (saleId: ${activeSale._id}). ` +
        "Run db/scripts/seed-db.ts to provision sale data.",
    );
  }
  const { productId, flashSalePrice } = saleProduct;

  // saleId drives Redis key namespacing (Story 4.2).
  const saleId = activeSale._id;

  // Sale resolution middleware — slug -> Sale doc with in-memory cache.
  const defaultSaleLookupOps: SaleLookupOps = {
    async findBySlug(slug: string): Promise<SaleSummary | null> {
      return slug === activeSale.slug ? (activeSale as SaleSummary) : null;
    },
    async findActiveSale(): Promise<SaleSummary | null> {
      return activeSale as SaleSummary;
    },
  };
  const saleResolver = createSaleResolver({
    ops: overrides.saleLookupOps ?? defaultSaleLookupOps,
    clock,
    cacheTtlMs: config.saleResolverCacheTtlMs,
  });

  // Story 4.6: one-time v1.0 -> v1.1 flat-key migration, strictly BEFORE
  // reconciliation below.
  const flatKeyMigrator = createFlatKeyMigrator(redis, logger, {
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });
  await flatKeyMigrator.migrate(saleId, activeSale.slug);

  const reconciler = createReconciler(redis, {
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });
  if (await reconciler.hasStockKey(saleId)) {
    // Warm start: surviving Redis state is authoritative — touch nothing.
  } else {
    // Cold start: rebuild Redis FROM MongoDB truth — never the reverse.
    const emails = await saleBootstrap.listConfirmedOrderEmails(saleId);
    const remaining = Math.max(0, activeSale.stockQuantity - emails.length);
    if (activeSale.stockQuantity - emails.length < 0) {
      logger.warn(
        { stockQuantity: activeSale.stockQuantity, confirmedOrders: emails.length },
        "cold rebuild: confirmed orders exceed sale.stockQuantity; clamping stock:remaining to 0",
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

  const saleStatus = createSaleStatusService({ clock, stock: stockStore });

  // Sale-events realtime layer.
  const eventPublisher = createEventPublisher(redis, {
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });
  const getActiveSale = async (): Promise<{ saleId: string; window: SaleWindow }> => {
    const active = await saleResolver.findActive();
    if (active === null) {
      throw new Error("no active sale configured");
    }
    return { saleId: active._id, window: windowFromSale(active) };
  };
  const saleEvents = createSaleEventsBroadcaster({
    saleStatus,
    clock,
    reportBroadcastFailure: (err) => {
      logger.error({ err }, "sse broadcast failed; closing open streams");
    },
    getActiveSale,
  });
  const duplicateRedis = overrides.duplicateRedis ?? ((client: RedisClient) => client.duplicate());
  const subscription = await createSaleEventsSubscription(duplicateRedis(redis), {
    saleId,
    onEvent: (event) => {
      saleEvents.onDomainEvent(event);
    },
    onConnectionLost: (err) => {
      logger.error({ err }, "sale-events pattern subscriber connection lost; closing open streams");
      saleEvents.closeAll();
    },
    connectTimeoutMs: config.redisConnectTimeoutMs * 5,
  });

  // Arm window timers from the DB-resolved active sale's timing.
  const windowTimers = armWindowTimers({
    clock,
    startMs: activeSale.startTime.getTime(),
    endMs: activeSale.endTime.getTime(),
    publish: (event) => eventPublisher.publish(event, saleId),
    onPublishFailure: (err) => {
      logger.error({ err }, "window-boundary event publish failed (logged, never thrown)");
    },
  });

  const catalog = createCatalogReader(mongoOps.catalog ?? mongoCatalogModelOps);

  // App assembly — saleId-parameterized ports (per Story 4.4).
  const orderAttemptPort: OrderAttemptPort = {
    attempt: (id, email) => orderStore.attempt(id, email),
    hasOrdered: (id, email) => orderStore.hasOrdered(id, email),
  };
  const orderEventsPort: OrderEventsPort = {
    publish: (event, id) => eventPublisher.publish(event, id),
  };
  const orderService = createOrderService({
    clock,
    orders: orderAttemptPort,
    audit: overrides.createOrderAudit
      ? overrides.createOrderAudit(productId, flashSalePrice)
      : createQueueAuditAdapter(
          createOrderQueueProducer(redis),
          productId,
          flashSalePrice,
        ),
    payment: overrides.payment ?? noopPaymentProvider,
    events: orderEventsPort,
    reportSideEffectFailure: (effect, err) => {
      logger.error({ err, effect }, "post-accept side effect failed (never alters the HTTP outcome)");
    },
  });
  const app = createApp({
    logger,
    apiRouter: createApiRouter({ saleStatus, saleEvents, orderService, saleResolver, catalog, stock: stockStore }),
    clientDistDir: env.CLIENT_DIST_DIR,
    bodyLimit: config.httpBodyLimit,
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
