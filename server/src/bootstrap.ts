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
import { createFlatKeyMigrator } from "./adapters/redis/migrate.ts";
import { createEventPublisher, createSaleEventsSubscription } from "./adapters/redis/events.ts";
import { connectMongo, disconnectMongo } from "./adapters/mongo/client.ts";
import { createOrderRecorder, mongoAuditModelOps, type AuditModelOps } from "./adapters/mongo/audit.ts";
import { createOrderQueueProducer, createQueueAuditAdapter } from "./adapters/redis/order-queue.ts";
import {
  createDomainSeeder,
  mongoSeedModelOps,
  type SeedModelOps,
} from "./adapters/mongo/seed.ts";
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
  /** Test seams — tests run the real recorder/seeder/catalog reader over fake model ops. */
  mongoModelOps?: { audit: AuditModelOps; seed: SeedModelOps; catalog: CatalogModelOps };
  /** Override the order audit adapter — factory receives the boot-seeded productId so tests
   *  that need immediate Mongo writes can inject createOrderRecorder(productId, ops) directly
   *  instead of the default write-behind queue adapter. */
  createOrderAudit?: (productId: string) => import("./services/order.ts").OrderAuditPort;
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
  await (overrides.connectMongoDb ?? ((uri: string) => connectMongo(uri, config.mongoSelectionTimeoutMs)))(config.mongodbUri);

  // Lua order script registration — SCRIPT LOAD + sha cache, strictly before
  // listen(); attempt() falls back to EVAL on NOSCRIPT.
  const orderStore = createOrderStore(redis, {
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });
  await orderStore.register();

  // Durable audit + restart safety, strictly before listen():
  // idempotent seed upserts, then the warm/cold gate on stock:{saleId}:remaining.
  const mongoOps = overrides.mongoModelOps ?? {
    audit: mongoAuditModelOps,
    seed: mongoSeedModelOps,
    catalog: mongoCatalogModelOps,
  };
  const seeder = createDomainSeeder(mongoOps.seed);
  const saleRefs = await seeder.seed(config);

  // Shared clock: the same instance feeds HTTP, the order service, and the
  // SSE broadcaster/timers.
  const clock = overrides.clock ?? systemClock;

  // Story 4.5: boot-time active-sale identification, made multi-sale-safe.
  // Exactly one Sale document exists today (the constant-slug singleton
  // `seeder.seed()` just upserted above), but this query and the selection
  // below are written generically over ALL Sale documents so a future
  // second Sale document — however it comes to exist; no admin API creates
  // one yet — is handled correctly with zero changes here.
  //
  // Fail fast (v1.1-NFR-5): at most one sale may have a [startTime, endTime)
  // window covering now() at any given moment. `isSaleActiveAt` is the same
  // window-containment primitive `selectActiveSale`'s "within window" tier
  // uses below and that sale-resolver.ts's discovery-endpoint ops would use
  // for a real multi-sale `findActiveSale()` implementation — one shared
  // definition of "currently live", not reimplemented per caller.
  const nowMsAtBoot = clock();
  const allSales = await seeder.listAllSales();
  const currentlyActiveSales = allSales.filter((sale) => isSaleActiveAt(sale, nowMsAtBoot));
  if (currentlyActiveSales.length > 1) {
    throw new ConfigError("Multiple active sales detected. Only one sale may be active at a time.");
  }
  // The sale reconciliation targets: within window > nearest upcoming >
  // most recently ended — the same forgiving priority as
  // sale-resolver.ts's findActive(), so boot reconciliation and the
  // discovery endpoint never disagree about "the" active sale. Reconciling
  // an upcoming (not-yet-open) or just-ended sale is intentional: a deploy
  // that lands before the window opens (or shortly after it closes) must
  // still provision that sale's Redis keys, matching v1.0's unconditional
  // boot-time reconcile of the single seeded sale.
  const activeSale = selectActiveSale(allSales, nowMsAtBoot);
  if (activeSale === null) {
    // Unreachable: seeder.seed() above always upserts exactly one Sale
    // document before this point runs.
    throw new ConfigError("No sale found to reconcile at boot.");
  }
  // Redis keys/channel are namespaced by saleId (Story 4.2) — the resolved
  // active Sale's Mongo ObjectId string, i.e. req.sale._id per the
  // sale-resolver middleware. The v1.0 flat keys (stock:remaining,
  // orders:users, sale:events) are no longer written or read by the live
  // request path; Story 4.6's flat-key migrator below (strictly before
  // reconciliation) is the one transient exception, running only at boot.
  const saleId = activeSale._id;

  // Sale resolution middleware — slug -> Sale doc with in-memory cache.
  // Note: the "active" slug guard now lives in loadConfig() so it is caught
  // before any connection is established. This comment is kept for audit trail.
  // Single-sale ops derived from the boot-resolved active sale. A later
  // story will replace this with a Mongoose-backed implementation for true
  // multi-sale slug lookup (Story 4.3 added the Mongo-backed
  // product/inventory join below, but sale identity itself is still this
  // boot-resolved singleton).
  const defaultSaleLookupOps: SaleLookupOps = {
    async findBySlug(slug: string): Promise<SaleSummary | null> {
      return slug === activeSale.slug ? activeSale : null;
    },
    async findActiveSale(): Promise<SaleSummary | null> {
      return activeSale;
    },
  };
  // Constructed early (right after seeding) because Story 4.4's SSE
  // broadcaster wiring below needs saleResolver.findActive() to derive the
  // currently-active sale for its pubsub/heartbeat-driven frame composition.
  const saleResolver = createSaleResolver({
    ops: overrides.saleLookupOps ?? defaultSaleLookupOps,
    clock,
    cacheTtlMs: config.saleResolverCacheTtlMs,
  });

  // Story 4.6: one-time v1.0 -> v1.1 flat-key migration, strictly BEFORE
  // reconciliation below. If a pre-4.2 deployment left surviving
  // stock:remaining/orders:users data, this RENAMEs it onto the resolved
  // active sale's namespaced keys so reconciliation's warm-start check sees
  // it as warm state rather than cold-rebuilding over it. No-op on a fresh
  // v1.1 install (no flat keys) and on every boot after the first migration.
  const flatKeyMigrator = createFlatKeyMigrator(redis, logger, {
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });
  await flatKeyMigrator.migrate(saleId, activeSale.slug);

  const reconciler = createReconciler(redis, {
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });
  if (await reconciler.hasStockKey(saleId)) {
    // Warm start: surviving Redis state is authoritative — touch nothing.
    // A changed STOCK_QUANTITY against surviving state is thereby a no-op;
    // a sale reset happens only via the explicit offline reset script.
  } else {
    // Cold start: rebuild Redis FROM MongoDB truth — never the reverse.
    const emails = await seeder.listConfirmedOrderEmails(saleId);
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

  // Story 4.4: saleId/window are per-call arguments now, not a bootstrap-
  // frozen dep — stockStore.getRemaining(saleId) already matches the
  // StockReader port shape exactly (Story 4.2), so it's injected unwrapped.
  const saleStatus = createSaleStatusService({ clock, stock: stockStore });

  // Sale-events realtime layer: PUBLISH rides the main client; SUBSCRIBE runs
  // on a dedicated duplicated connection; boot arms window timers for FUTURE
  // boundaries only. Subscriber failure here rejects bootstrap() — fail-fast
  // strictly before listen().
  const eventPublisher = createEventPublisher(redis, {
    commandTimeoutMs: config.redisCommandTimeoutMs,
  });
  // Story 4.4: the broadcaster's pubsub/heartbeat-driven composition (no
  // request context) re-derives the active sale on every call through the
  // same cached resolver req.sale routes use, rather than a saleId frozen at
  // construction — see services/sale-events.ts's file header for why this
  // differs from snapshotFrame(), which takes req.sale explicitly.
  const getActiveSale = async (): Promise<{ saleId: string; window: SaleWindow }> => {
    const active = await saleResolver.findActive();
    if (active === null) {
      // Unreachable given this system always boot-seeds exactly one sale;
      // treated as a compose failure by the broadcaster's callers (report +
      // fail closed) rather than fabricating a sale identity.
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

  // Story 4.3: the Sale -> SaleProduct -> Product -> Inventory join, read by
  // the sale details endpoint. Reuses the unbound `stockStore` (getRemaining
  // takes saleId directly) since the endpoint resolves its saleId per
  // request via req.sale.
  const catalog = createCatalogReader(mongoOps.catalog);

  // 4. App assembly.
  // Story 4.4: these ports are now pure saleId-parameterized passthroughs —
  // no bootstrap-frozen saleId closure. The route handlers (routes/order.ts)
  // pass req.sale._id through to the order service on every call.
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
    // productId still closes over the single boot-seeded product (v1.1 ships
    // exactly one product per sale, per Story 4.3) — only saleId travels
    // per-call now.
    // Write-Behind: default path enqueues to the Redis Stream; a worker process
    // drains it into MongoDB asynchronously. Tests that need immediate Mongo
    // writes (audit + cold-restart tests) inject createOrderAudit to bypass the queue.
    audit: overrides.createOrderAudit
      ? overrides.createOrderAudit(saleRefs.productId)
      : createQueueAuditAdapter(createOrderQueueProducer(redis), saleRefs.productId),
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
