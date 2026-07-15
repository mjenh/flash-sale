// Two different saleIds must produce fully isolated Redis namespaces: an
// order accepted for sale A must not appear in sale B's membership set, and
// stock decrements for one sale must never affect the other. Exercised
// against the shared in-memory fake Redis test double (see helpers/fake-redis.ts)
// — one level below bootstrap() so the isolation claim is proven directly
// against the adapters (orders.ts, stock.ts, reconcile.ts, events.ts) rather
// than incidentally through an HTTP round trip.
import { describe, expect, it } from "vitest";
import { createEventPublisher, createSaleEventsSubscription } from "../src/adapters/redis/events.ts";
import { createOrderStore } from "../src/adapters/redis/orders.ts";
import { createReconciler } from "../src/adapters/redis/reconcile.ts";
import { createStockStore } from "../src/adapters/redis/stock.ts";
import { createFakeRedis, orderSetMembers, orderSetSize, stockKeyFor } from "./helpers/fake-redis.ts";

const OPTS = { commandTimeoutMs: 50 };
const SALE_A = "sale-aaaaaaaaaaaaaaaaaaaaaaaa";
const SALE_B = "sale-bbbbbbbbbbbbbbbbbbbbbbbb";

describe("Redis key namespace isolation across saleIds", () => {
  it("stock:{saleId}:remaining is independent per sale — a decrement in A never touches B", async () => {
    const fake = createFakeRedis();
    fake.kv.set(stockKeyFor(SALE_A), "5");
    fake.kv.set(stockKeyFor(SALE_B), "5");

    const orders = createOrderStore(fake.client, OPTS);
    await orders.register();

    const a1 = await orders.attempt(SALE_A, "buyer@example.com");
    expect(a1).toEqual({ verdict: "OK", remaining: 4 });

    // Sale B's stock is untouched by sale A's accepted order.
    expect(fake.kv.get(stockKeyFor(SALE_B))).toBe("5");
    expect(fake.kv.get(stockKeyFor(SALE_A))).toBe("4");
  });

  it("orders:{saleId}:users membership is independent per sale — the same email can hold one order in EACH sale", async () => {
    const fake = createFakeRedis();
    fake.kv.set(stockKeyFor(SALE_A), "5");
    fake.kv.set(stockKeyFor(SALE_B), "5");

    const orders = createOrderStore(fake.client, OPTS);
    await orders.register();

    // The identical email orders in BOTH sales — a real-world scenario a
    // flat, unscoped key would corrupt (the second order would read as
    // ALREADY against the first sale's membership).
    const inA = await orders.attempt(SALE_A, "shopper@example.com");
    const inB = await orders.attempt(SALE_B, "shopper@example.com");
    expect(inA).toEqual({ verdict: "OK", remaining: 4 });
    expect(inB).toEqual({ verdict: "OK", remaining: 4 }); // independent stock, not "ALREADY"

    expect(orderSetMembers(fake, SALE_A)).toEqual(["shopper@example.com"]);
    expect(orderSetMembers(fake, SALE_B)).toEqual(["shopper@example.com"]);
    expect(orderSetSize(fake, SALE_A)).toBe(1);
    expect(orderSetSize(fake, SALE_B)).toBe(1);

    // hasOrdered() is scoped identically: an email confirmed in A alone
    // never reads back as "ordered" against B.
    const soloA = await orders.attempt(SALE_A, "solo-a@example.com");
    expect(soloA.verdict).toBe("OK");
    expect(await orders.hasOrdered(SALE_A, "solo-a@example.com")).toBe(true);
    expect(await orders.hasOrdered(SALE_B, "solo-a@example.com")).toBe(false);
  });

  it("SOLD_OUT in one sale never blocks orders in another sale sharing the same Redis instance", async () => {
    const fake = createFakeRedis();
    fake.kv.set(stockKeyFor(SALE_A), "0"); // A is already sold out
    fake.kv.set(stockKeyFor(SALE_B), "1"); // B still has stock

    const orders = createOrderStore(fake.client, OPTS);
    await orders.register();

    const soldOutInA = await orders.attempt(SALE_A, "late@example.com");
    expect(soldOutInA).toEqual({ verdict: "SOLD_OUT", remaining: 0 });

    const okInB = await orders.attempt(SALE_B, "late@example.com");
    expect(okInB).toEqual({ verdict: "OK", remaining: 0 });
  });

  it("stockStore.getRemaining reads the correct sale-scoped key for each saleId", async () => {
    const fake = createFakeRedis();
    fake.kv.set(stockKeyFor(SALE_A), "10");
    fake.kv.set(stockKeyFor(SALE_B), "99");
    const stock = createStockStore(fake.client, OPTS);

    await expect(stock.getRemaining(SALE_A)).resolves.toBe(10);
    await expect(stock.getRemaining(SALE_B)).resolves.toBe(99);
  });

  it("reconciler.rebuild() for one saleId never disturbs another saleId's surviving state", async () => {
    const fake = createFakeRedis();
    fake.kv.set(stockKeyFor(SALE_B), "42"); // B's warm state, must survive untouched
    fake.sets.set(`orders:${SALE_B}:users`, new Set(["existing-b@example.com"]));

    const reconciler = createReconciler(fake.client, OPTS);
    // Cold rebuild ONLY for sale A.
    await reconciler.rebuild(["a1@example.com", "a2@example.com"], 8, SALE_A);

    expect(fake.kv.get(stockKeyFor(SALE_A))).toBe("8");
    expect(orderSetMembers(fake, SALE_A)).toEqual(["a1@example.com", "a2@example.com"]);
    // Sale B's state is completely untouched.
    expect(fake.kv.get(stockKeyFor(SALE_B))).toBe("42");
    expect(orderSetMembers(fake, SALE_B)).toEqual(["existing-b@example.com"]);
  });

  it("PSUBSCRIBE sale:*:events delivers events from ALL sales to ALL pattern subscribers — broadcaster-level getActiveSale() provides the per-sale filter", async () => {
    // Finding #5: createSaleEventsSubscription now uses pSubscribe(sale:*:events)
    // rather than a per-saleId subscribe. Both subscribers receive every sale's
    // events; isolation is enforced at the broadcaster layer (getActiveSale()
    // re-reads which sale is active and only composes frames for it).
    const fake = createFakeRedis();
    const publisher = createEventPublisher(fake.client, OPTS);

    const receivedByA: string[] = [];
    const receivedByB: string[] = [];
    await createSaleEventsSubscription(fake.client.duplicate(), {
      saleId: SALE_A,
      onEvent: (event) => receivedByA.push(event),
      onConnectionLost: () => {},
      connectTimeoutMs: 1000,
    });
    await createSaleEventsSubscription(fake.client.duplicate(), {
      saleId: SALE_B,
      onEvent: (event) => receivedByB.push(event),
      onConnectionLost: () => {},
      connectTimeoutMs: 1000,
    });

    await publisher.publish("sale.sold_out", SALE_A);
    await publisher.publish("sale.started", SALE_B);

    // Both subscribers receive both events — pattern subscription is sale-agnostic.
    expect(receivedByA).toEqual(["sale.sold_out", "sale.started"]);
    expect(receivedByB).toEqual(["sale.sold_out", "sale.started"]);
  });
});
