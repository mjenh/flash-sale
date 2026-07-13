// Unit tests for the sale:events Redis adapter (Story 1.6 AC 1/5) — fake
// clients, zero I/O. The publisher is one bounded PUBLISH on the exact spine
// channel (timeout AND rejection wrap into RedisUnavailableError); the
// subscription wires the DEDICATED duplicated connection: error listener
// BEFORE connect, fail-fast bounded connect, SUBSCRIBE sale:events,
// best-effort teardown.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SALE_EVENTS_CHANNEL,
  createEventPublisher,
  createSaleEventsSubscription,
} from "../src/adapters/redis/events.ts";
import { RedisUnavailableError } from "../src/adapters/redis/stock.ts";
import type { SaleEventType } from "../src/services/sale-events.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("createEventPublisher", () => {
  const ALL_EVENTS: SaleEventType[] = [
    "order.accepted",
    "sale.sold_out",
    "sale.started",
    "sale.ended",
  ];

  it("the channel is exactly the spine's sale:events", () => {
    expect(SALE_EVENTS_CHANNEL).toBe("sale:events");
  });

  for (const event of ALL_EVENTS) {
    it(`publishes exactly PUBLISH("sale:events", "${event}") — type-only payload, no envelope`, async () => {
      const client = { publish: vi.fn(async () => 1) };
      const publisher = createEventPublisher(client, { commandTimeoutMs: 1000 });
      await publisher.publish(event);
      expect(client.publish).toHaveBeenCalledExactlyOnceWith("sale:events", event);
    });
  }

  it("a hung publish rejects with RedisUnavailableError within commandTimeoutMs (AD-5 bounded)", async () => {
    vi.useFakeTimers();
    const client = { publish: vi.fn(() => new Promise<number>(() => {})) };
    const publisher = createEventPublisher(client, { commandTimeoutMs: 1000 });
    const outcome = expect(publisher.publish("order.accepted")).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
  });

  it("a rejected publish wraps into RedisUnavailableError", async () => {
    const client = {
      publish: vi.fn(async () => {
        throw new Error("connection lost");
      }),
    };
    const publisher = createEventPublisher(client, { commandTimeoutMs: 1000 });
    await expect(publisher.publish("sale.sold_out")).rejects.toBeInstanceOf(RedisUnavailableError);
  });
});

function fakeSubscriber() {
  const errorListeners: Array<(err: Error) => void> = [];
  const listeners = new Map<string, (message: string) => void>();
  const subscriber = {
    isOpen: false,
    connect: vi.fn(async () => {
      subscriber.isOpen = true;
    }),
    subscribe: vi.fn(async (channel: string, listener: (message: string) => void) => {
      listeners.set(channel, listener);
    }),
    unsubscribe: vi.fn(async (channel: string) => {
      listeners.delete(channel);
    }),
    on: vi.fn((event: "error", listener: (err: Error) => void) => {
      if (event === "error") {
        errorListeners.push(listener);
      }
      return subscriber;
    }),
    destroy: vi.fn(() => {
      subscriber.isOpen = false;
    }),
    close: vi.fn(async () => {
      subscriber.isOpen = false;
    }),
  };
  return { subscriber, errorListeners, listeners };
}

describe("createSaleEventsSubscription", () => {
  const options = (overrides: Partial<Parameters<typeof createSaleEventsSubscription>[1]> = {}) => ({
    onEvent: vi.fn(),
    onConnectionLost: vi.fn(),
    connectTimeoutMs: 1000,
    ...overrides,
  });

  it("subscribes to exactly sale:events and forwards messages to onEvent", async () => {
    const { subscriber, listeners } = fakeSubscriber();
    const opts = options();
    await createSaleEventsSubscription(subscriber, opts);

    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.subscribe.mock.calls[0]?.[0]).toBe("sale:events");
    expect([...listeners.keys()]).toEqual(["sale:events"]);

    listeners.get("sale:events")?.("order.accepted");
    expect(opts.onEvent).toHaveBeenCalledExactlyOnceWith("order.accepted");
  });

  it("registers the error listener BEFORE connecting and forwards errors to onConnectionLost", async () => {
    const { subscriber, errorListeners } = fakeSubscriber();
    const opts = options();
    await createSaleEventsSubscription(subscriber, opts);

    const onOrder = subscriber.on.mock.invocationCallOrder[0] as number;
    const connectOrder = subscriber.connect.mock.invocationCallOrder[0] as number;
    expect(onOrder).toBeLessThan(connectOrder);

    const boom = new Error("subscriber gone");
    for (const listener of errorListeners) {
      listener(boom);
    }
    expect(opts.onConnectionLost).toHaveBeenCalledExactlyOnceWith(boom);
  });

  it("a hung connect rejects with RedisUnavailableError within connectTimeoutMs (boot fail-fast)", async () => {
    vi.useFakeTimers();
    const { subscriber } = fakeSubscriber();
    subscriber.connect = vi.fn(() => new Promise<void>(() => {})) as typeof subscriber.connect;
    const outcome = expect(
      createSaleEventsSubscription(subscriber, options()),
    ).rejects.toBeInstanceOf(RedisUnavailableError);
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
    expect(subscriber.destroy).toHaveBeenCalledTimes(1);
    expect(subscriber.subscribe).not.toHaveBeenCalled();
  });

  it("a rejected connect wraps into RedisUnavailableError and destroys the client", async () => {
    const { subscriber } = fakeSubscriber();
    subscriber.connect = vi.fn(async () => {
      throw new Error("refused");
    }) as typeof subscriber.connect;
    await expect(createSaleEventsSubscription(subscriber, options())).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
    expect(subscriber.destroy).toHaveBeenCalledTimes(1);
  });

  it("a subscribe failure after connect destroys the connection and wraps into RedisUnavailableError", async () => {
    const { subscriber } = fakeSubscriber();
    subscriber.subscribe = vi.fn(async () => {
      throw new Error("subscribe refused");
    }) as typeof subscriber.subscribe;
    await expect(createSaleEventsSubscription(subscriber, options())).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
    expect(subscriber.destroy).toHaveBeenCalledTimes(1);
  });

  it("close() unsubscribes from sale:events and closes the open connection", async () => {
    const { subscriber } = fakeSubscriber();
    const subscription = await createSaleEventsSubscription(subscriber, options());
    await subscription.close();
    expect(subscriber.unsubscribe).toHaveBeenCalledExactlyOnceWith("sale:events");
    expect(subscriber.close).toHaveBeenCalledTimes(1);
  });

  it("close() is best-effort: unsubscribe rejection is swallowed and a dead client is destroy()ed", async () => {
    const { subscriber } = fakeSubscriber();
    const subscription = await createSaleEventsSubscription(subscriber, options());
    subscriber.unsubscribe = vi.fn(async () => {
      throw new Error("already gone");
    }) as typeof subscriber.unsubscribe;
    subscriber.isOpen = false;
    await subscription.close(); // must not throw
    expect(subscriber.close).not.toHaveBeenCalled();
    expect(subscriber.destroy).toHaveBeenCalledTimes(1);
  });
});
