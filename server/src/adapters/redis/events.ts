// Redis adapter for the AD-9 realtime layer: the `sale:events` pub/sub
// channel is the ONLY Redis surface this story adds — publishes never touch
// stock:remaining / orders:users (AD-1's permitted writers are unchanged).
// Zero business rules (AD-7): this file doesn't know which events are
// terminal or when to publish — it moves strings.
//
// PUBLISH rides the MAIN client (an ordinary command, bounded per AD-5);
// only SUBSCRIBE lives on a dedicated duplicated connection, because Redis's
// subscriber mode blocks normal commands on that connection.
import { bounded, RedisUnavailableError } from "./stock.ts";
import type { SaleEventType } from "../../services/sale-events.ts";

export const SALE_EVENTS_CHANNEL = "sale:events";

/** Narrow command surface — structurally satisfied by node-redis RedisClientType. */
export interface PublishCommands {
  publish(channel: string, message: string): Promise<unknown>;
}

export interface EventPublisherOptions {
  commandTimeoutMs: number;
}

/** Satisfies the order service's OrderEventsPort and the window timers'
 *  publish dependency. Type-only payloads: the event string IS the message
 *  (AD-9 — consumers compose truth from a fresh read, never from payloads). */
export interface EventPublisher {
  publish(event: SaleEventType): Promise<void>;
}

export function createEventPublisher(
  client: PublishCommands,
  { commandTimeoutMs }: EventPublisherOptions,
): EventPublisher {
  return {
    async publish(event: SaleEventType): Promise<void> {
      // bounded() wraps timeout AND rejection into RedisUnavailableError;
      // callers fire-and-forget with their own report hook — a publish
      // failure never alters an HTTP outcome (AD-9).
      await bounded(client.publish(SALE_EVENTS_CHANNEL, event), commandTimeoutMs);
    },
  };
}

/** Narrow surface of the DEDICATED duplicated subscriber connection —
 *  structurally satisfied by node-redis RedisClientType. */
export interface SubscriberCommands {
  connect(): Promise<unknown>;
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: "error", listener: (err: Error) => void): unknown;
  destroy(): void;
  close(): Promise<unknown> | void;
  isOpen: boolean;
}

export interface SaleEventsSubscriptionOptions {
  onEvent: (event: string) => void;
  /** The AD-5 mid-stream trigger — bootstrap closes every open SSE stream. */
  onConnectionLost: (err: Error) => void;
  connectTimeoutMs: number;
}

export interface SaleEventsSubscription {
  close(): Promise<void>;
}

/** Wires the dedicated duplicated connection (AD-9): error listener FIRST
 *  (an unhandled 'error' would crash the process — and it is the
 *  connection-lost signal), then a fail-fast bounded connect (a rejection
 *  fails bootstrap() strictly before listen()), then SUBSCRIBE sale:events. */
export async function createSaleEventsSubscription(
  subscriber: SubscriberCommands,
  { onEvent, onConnectionLost, connectTimeoutMs }: SaleEventsSubscriptionOptions,
): Promise<SaleEventsSubscription> {
  subscriber.on("error", onConnectionLost);

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      subscriber.connect(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new RedisUnavailableError(
              new Error(`sale:events subscriber not connected within ${connectTimeoutMs} ms`),
            ),
          );
        }, connectTimeoutMs);
      }),
    ]);
  } catch (err) {
    subscriber.destroy();
    throw err instanceof RedisUnavailableError ? err : new RedisUnavailableError(err);
  } finally {
    clearTimeout(timer);
  }

  await subscriber.subscribe(SALE_EVENTS_CHANNEL, (message: string) => {
    onEvent(message);
  });

  return {
    async close(): Promise<void> {
      try {
        await subscriber.unsubscribe(SALE_EVENTS_CHANNEL);
      } catch {
        // Best-effort: a dead connection has nothing to unsubscribe.
      }
      try {
        if (subscriber.isOpen) {
          await subscriber.close();
        } else {
          subscriber.destroy();
        }
      } catch {
        subscriber.destroy();
      }
    },
  };
}
