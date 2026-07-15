// Write-Behind producer/consumer for the `queue:orders` Redis Stream.
//
// Producer — createOrderQueueProducer(redis):
//   XADD serializes each accepted order (post-Redis-verdict) to the stream.
//   createQueueAuditAdapter wraps it as an OrderAuditPort drop-in for bootstrap.
//
// Consumer — createOrderQueueConsumer(redis):
//   XREADGROUP reads batches; XACK only after confirmed MongoDB write.
//   Used exclusively by server/src/worker/*.
//
// Key invariant: messages are ACKed ONLY after MongoDB confirms the write.
// A worker crash leaves them in the PEL so the next restart re-delivers them.
import { randomUUID } from "node:crypto";
import type { RedisClient } from "./client.ts";
import type { OrderAuditPort } from "../../services/order.ts";

export const QUEUE_STREAM_KEY = "queue:orders";
export const WORKER_GROUP = "workers";
export const WORKER_CONSUMER_ID = "worker-1";

/** Payload stored in every Redis Stream entry. */
export interface QueueOrderPayload {
  /** UUID generated at enqueue — correlation ID for idempotency checks. */
  orderId: string;
  saleId: string;
  /** Boot-seeded productId — needed by the worker to write the OrderLine. */
  productId: string;
  email: string;
  /** UTC epoch ms when the order was accepted by Redis. */
  enqueuedAt: number;
}

/** A deserialized stream entry as returned by readBatch(). */
export interface QueueMessage {
  /** Redis Stream entry ID, e.g. "1720000000000-0". */
  streamId: string;
  payload: QueueOrderPayload;
}

export interface OrderQueueProducer {
  /** XADD the order payload to the stream; returns the generated orderId UUID. */
  enqueue(saleId: string, productId: string, email: string): Promise<string>;
}

export interface OrderQueueConsumer {
  /** Idempotently creates the consumer group (MKSTREAM on first call). */
  ensureGroup(): Promise<void>;
  /** XREADGROUP id="0" — re-delivers messages already in this consumer's PEL.
   *  Call this first on every loop iteration to retry any unACKed entries from
   *  a previous failed write before reading new messages with readBatch(). */
  readPending(count: number): Promise<QueueMessage[]>;
  /** XREADGROUP id=">" — claims up to `count` new (never-delivered) messages;
   *  blocks for `blockMs`. Only call when readPending() returns empty. */
  readBatch(count: number, blockMs: number): Promise<QueueMessage[]>;
  /** XACK — removes entries from the PEL after a confirmed MongoDB write. */
  ack(streamIds: string[]): Promise<void>;
}

export function createOrderQueueProducer(redis: RedisClient): OrderQueueProducer {
  return {
    async enqueue(saleId: string, productId: string, email: string): Promise<string> {
      const orderId = randomUUID();
      const payload: QueueOrderPayload = {
        orderId,
        saleId,
        productId,
        email,
        enqueuedAt: Date.now(),
      };
      // XADD queue:orders * orderId <uuid> data <json-payload>
      await redis.xAdd(QUEUE_STREAM_KEY, "*", {
        orderId,
        data: JSON.stringify(payload),
      });
      return orderId;
    },
  };
}

function parseStreamResult(result: Awaited<ReturnType<RedisClient["xReadGroup"]>>): QueueMessage[] {
  if (result === null || result.length === 0) {
    return [];
  }
  const messages: QueueMessage[] = [];
  for (const stream of result) {
    for (const entry of stream.messages) {
      const raw = entry.message["data"];
      if (typeof raw !== "string") {
        continue;
      }
      try {
        const payload = JSON.parse(raw) as QueueOrderPayload;
        messages.push({ streamId: entry.id, payload });
      } catch {
        // Malformed entry — leave in PEL; inspect/trim via XPENDING / XDEL.
      }
    }
  }
  return messages;
}

export function createOrderQueueConsumer(redis: RedisClient): OrderQueueConsumer {
  return {
    async ensureGroup(): Promise<void> {
      try {
        // "0" so a restarted worker re-reads its own PEL before new entries.
        // MKSTREAM creates the stream key if it doesn't exist yet.
        await redis.xGroupCreate(QUEUE_STREAM_KEY, WORKER_GROUP, "0", { MKSTREAM: true });
      } catch (err) {
        // BUSYGROUP: group already exists — idempotent, not an error.
        if (err instanceof Error && err.message.includes("BUSYGROUP")) {
          return;
        }
        throw err;
      }
    },

    async readPending(count: number): Promise<QueueMessage[]> {
      // id="0" re-delivers messages already claimed by this consumer (unACKed).
      // Returns empty when the PEL is clear — caller then switches to readBatch.
      const result = await redis.xReadGroup(
        WORKER_GROUP,
        WORKER_CONSUMER_ID,
        [{ key: QUEUE_STREAM_KEY, id: "0" }],
        { COUNT: count },
      );
      return parseStreamResult(result);
    },

    async readBatch(count: number, blockMs: number): Promise<QueueMessage[]> {
      // id=">" delivers only new, never-delivered-to-this-group messages.
      const result = await redis.xReadGroup(
        WORKER_GROUP,
        WORKER_CONSUMER_ID,
        [{ key: QUEUE_STREAM_KEY, id: ">" }],
        { COUNT: count, BLOCK: blockMs },
      );
      return parseStreamResult(result);
    },

    async ack(streamIds: string[]): Promise<void> {
      if (streamIds.length === 0) {
        return;
      }
      await redis.xAck(QUEUE_STREAM_KEY, WORKER_GROUP, streamIds);
    },
  };
}

/** Implements OrderAuditPort by enqueuing to the Redis Stream instead of
 *  writing MongoDB directly. Drop-in replacement for createOrderRecorder()
 *  in bootstrap. The worker process drains the stream into MongoDB. */
export function createQueueAuditAdapter(
  producer: OrderQueueProducer,
  productId: string,
): OrderAuditPort {
  return {
    async recordOrder(saleId: string, email: string): Promise<void> {
      await producer.enqueue(saleId, productId, email);
    },
  };
}
