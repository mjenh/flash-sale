// Worker entrypoint — a separate process from src/index.ts.
// Boot order: config -> Redis connect -> MongoDB connect -> start worker loop.
// Teardown (SIGTERM/SIGINT): finish current batch -> disconnect MongoDB -> close Redis.
import { pino } from "pino";
import { loadWorkerConfig } from "../adapters/config.ts";
import { mongoBulkAudit } from "../adapters/mongo/bulk-audit.ts";
import { connectMongo, disconnectMongo } from "../adapters/mongo/client.ts";
import { createRedisClient } from "../adapters/redis/client.ts";
import { createOrderWorker } from "./order-worker.ts";

const logger = pino();

async function main(): Promise<void> {
  const config = loadWorkerConfig();

  // Redis — same options as the API server; fail-closed on disconnection.
  const redis = createRedisClient(
    config,
    (err) => logger.error({ err }, "worker: redis error"),
  );
  await redis.connect();

  // MongoDB — must be connected before the worker loop starts draining the stream.
  await connectMongo(config.mongodbUri);

  const worker = createOrderWorker({
    redis,
    bulkAudit: mongoBulkAudit,
    logger,
    consumerId: config.workerConsumerId,
    groupId: config.workerGroup,
  });
  worker.start();

  logger.info(
    {
      redisUrl: config.redisUrl,
      mongodbUri: config.mongodbUri,
      consumerId: config.workerConsumerId,
      groupId: config.workerGroup,
    },
    "order worker started",
  );

  // Graceful shutdown: finish the current batch then exit cleanly.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "worker: shutdown signal; finishing current batch");
    try {
      await worker.stop();
      await disconnectMongo();
      if (redis.isOpen) {
        await redis.close();
      }
      process.exit(0);
    } catch (err: unknown) {
      logger.error({ err }, "worker: teardown error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("[worker] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
