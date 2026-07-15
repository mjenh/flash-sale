// Write-Behind consumer worker.
//
// Polls `queue:orders` (XREADGROUP), writes each batch to MongoDB via
// BulkAuditPort.bulkRecordOrders, then ACKs the batch (XACK).
//
// At-least-once delivery: messages are ACKed ONLY after MongoDB confirms.
// A write failure keeps them in the PEL — the next iteration re-delivers.
//
// Exponential backoff: a MongoDB outage backs off exponentially (500 ms →
// 30 s cap) without losing messages.
//
// Graceful shutdown: stop() waits for the current batch to finish before
// the process exits, so SIGTERM never tears mid-write.
import type { Logger } from "pino";
import type { RedisClient } from "../adapters/redis/client.ts";
import {
  createOrderQueueConsumer,
  type QueueMessage,
} from "../adapters/redis/order-queue.ts";
import type { BulkAuditPort } from "../adapters/mongo/bulk-audit.ts";

export interface WorkerOptions {
  redis: RedisClient;
  bulkAudit: BulkAuditPort;
  logger: Logger;
  /** Max messages per XREADGROUP call (default: 50). */
  batchSize?: number;
  /** BLOCK wait on XREADGROUP in ms — avoids busy-polling (default: 500). */
  blockMs?: number;
}

export interface OrderWorker {
  /** Start the polling loop (non-blocking — runs in background). */
  start(): void;
  /** Signal the loop to exit; resolves once the current batch finishes. */
  stop(): Promise<void>;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createOrderWorker({
  redis,
  bulkAudit,
  logger,
  batchSize = 50,
  blockMs = 500,
}: WorkerOptions): OrderWorker {
  const consumer = createOrderQueueConsumer(redis);
  let running = false;
  let backoffMs = INITIAL_BACKOFF_MS;
  // Kept so stop() can await the loop settling cleanly.
  let loopSettled: Promise<void> | undefined;

  async function writeBatch(messages: QueueMessage[]): Promise<void> {
    try {
      await bulkAudit.bulkRecordOrders(messages.map((m) => m.payload));
      // ACK only after MongoDB confirms — messages stay in PEL if we crash here.
      await consumer.ack(messages.map((m) => m.streamId));
      backoffMs = INITIAL_BACKOFF_MS; // reset on success
      logger.info({ count: messages.length }, "worker: batch persisted and ACKed");
    } catch (err) {
      // Do NOT ACK — messages remain in PEL and will be re-delivered.
      logger.error(
        { err, count: messages.length },
        "worker: batch write failed; NOT ACKed; backing off",
      );
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  async function loop(): Promise<void> {
    await consumer.ensureGroup();
    logger.info("worker: consumer group ready; polling queue:orders");

    while (running) {
      try {
        // Phase 1: re-deliver any unACKed entries from a previous failed write.
        // This is what retries the batch after a Mongo outage — id="0" returns
        // messages already in our PEL, id=">" (readBatch) would skip them.
        let messages = await consumer.readPending(batchSize);

        // Phase 2: no pending entries — block-wait for new ones.
        if (messages.length === 0) {
          messages = await consumer.readBatch(batchSize, blockMs);
        }

        if (messages.length > 0) {
          await writeBatch(messages);
        }
      } catch (err) {
        // Redis read error (disconnected, timeout, etc.).
        logger.error({ err }, "worker: read error; backing off");
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }

    logger.info("worker: loop exited cleanly");
  }

  return {
    start(): void {
      running = true;
      loopSettled = loop().catch((err: unknown) => {
        logger.error({ err }, "worker: unhandled loop error");
      });
    },

    async stop(): Promise<void> {
      running = false;
      // Wait for the current batch (or BLOCK wait) to finish — never tears mid-write.
      if (loopSettled !== undefined) {
        await loopSettled;
      }
    },
  };
}
