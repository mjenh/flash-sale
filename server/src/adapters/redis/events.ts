// Redis adapter for the `sale:{saleId}:events` pub/sub channel. Publishes
// never touch stock:{saleId}:remaining or orders:{saleId}:users. This file
// doesn't know which events are terminal or when to publish — it moves
// strings.
//
// PUBLISH rides the main client (an ordinary bounded command); only SUBSCRIBE
// lives on a dedicated duplicated connection, because Redis's subscriber mode
// blocks normal commands on that connection.
//
// Story 4.2: the channel is namespaced by saleId so SSE subscribers for a
// given sale only ever hear that sale's domain events. The v1.0 flat
// `sale:events` channel is no longer published to or subscribed on.
import { bounded, RedisUnavailableError } from "./stock.ts";
import type { SaleEventType } from "../../services/sale-events.ts";

export function saleEventsChannel(saleId: string): string {
  return `sale:${saleId}:events`;
}

/** Narrow command surface — structurally satisfied by node-redis RedisClientType. */
export interface PublishCommands {
  publish(channel: string, message: string): Promise<unknown>;
}

export interface EventPublisherOptions {
  commandTimeoutMs: number;
}

/** Underlies the order service's OrderEventsPort and the window timers'
 *  publish dependency (bootstrap binds a fixed saleId into those narrower
 *  ports — see bootstrap.ts). Type-only payloads: the event string is the
 *  message — consumers compose truth from a fresh read, never from payloads. */
export interface EventPublisher {
  publish(event: SaleEventType, saleId: string): Promise<void>;
}

export function createEventPublisher(
  client: PublishCommands,
  { commandTimeoutMs }: EventPublisherOptions,
): EventPublisher {
  return {
    async publish(event: SaleEventType, saleId: string): Promise<void> {
      // bounded() wraps timeout and rejection into RedisUnavailableError;
      // callers fire-and-forget with their own report hook — a publish
      // failure never alters an HTTP outcome.
      await bounded(client.publish(saleEventsChannel(saleId), event), commandTimeoutMs);
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
  /** The sale whose channel this subscriber follows — Story 4.2 subscribes
   *  to `sale:{saleId}:events` only. */
  saleId: string;
  onEvent: (event: string) => void;
  /** Mid-stream trigger — bootstrap closes every open SSE stream on connection loss. */
  onConnectionLost: (err: Error) => void;
  connectTimeoutMs: number;
}

export interface SaleEventsSubscription {
  close(): Promise<void>;
}

/** Wires the dedicated duplicated connection: error listener first (an
 *  unhandled 'error' would crash the process — and it is the connection-lost
 *  signal), then a fail-fast bounded connect (a rejection fails bootstrap()
 *  strictly before listen()), then SUBSCRIBE sale:{saleId}:events. */
export async function createSaleEventsSubscription(
  subscriber: SubscriberCommands,
  { saleId, onEvent, onConnectionLost, connectTimeoutMs }: SaleEventsSubscriptionOptions,
): Promise<SaleEventsSubscription> {
  const channel = saleEventsChannel(saleId);
  subscriber.on("error", onConnectionLost);

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      subscriber.connect(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new RedisUnavailableError(
              new Error(`${channel} subscriber not connected within ${connectTimeoutMs} ms`),
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

  // A subscribe failure after a successful connect must not leak the duplicated
  // connection: destroy it and surface a wrapped RedisUnavailableError.
  try {
    await subscriber.subscribe(channel, (message: string) => {
      onEvent(message);
    });
  } catch (err) {
    subscriber.destroy();
    throw err instanceof RedisUnavailableError ? err : new RedisUnavailableError(err);
  }

  return {
    async close(): Promise<void> {
      // Bound teardown with the same timeout discipline as connect — a hung
      // unsubscribe/close must never block shutdown; on timeout, destroy().
      try {
        await bounded(Promise.resolve(subscriber.unsubscribe(channel)), connectTimeoutMs);
      } catch {
        // Best-effort: a dead connection has nothing to unsubscribe.
      }
      try {
        if (subscriber.isOpen) {
          await bounded(Promise.resolve(subscriber.close()), connectTimeoutMs);
        } else {
          subscriber.destroy();
        }
      } catch {
        subscriber.destroy();
      }
    },
  };
}
