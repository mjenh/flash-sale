// Integration tests through the REAL bootstrap() — durable audit + restart
// safety. Redis is the shared in-memory fake; Mongo model ops are the shared
// in-memory fake, but the REAL createOrderRecorder / createDomainSeeder /
// createReconciler compositions run over them.
//
// Story 4.2: Redis keys are namespaced by saleId. boot() always reserves the
// (idempotent) saleId up front from the shared mongo — reused across boots
// so the sale-scoped keys stay identical across restarts.
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { pino, type Logger } from "pino";
import { bootstrap, type BootstrapOverrides } from "../src/bootstrap.ts";
import { SALE_SLUG } from "../src/adapters/mongo/seed.ts";
import { createOrderRecorder } from "../src/adapters/mongo/audit.ts";
import type { PaymentProvider } from "../src/services/payment.ts";
import {
  createFakeRedis,
  orderSetMembers,
  orderSetSize,
  stockKeyFor,
  ordersKeyFor,
  type FakeRedis,
} from "./helpers/fake-redis.ts";
import { createFakeMongo, reserveSaleId, type FakeMongo } from "./helpers/fake-mongo.ts";
import { START_MS, IN_WINDOW, START_ISO, END_ISO } from "./helpers/time-fixtures.ts";

const SALE_START = START_ISO;
const SALE_END = END_ISO;
const startMs = START_MS;

/** Drain macro/microtasks so the fire-and-forget side effects settle. */
const drain = () => new Promise((resolve) => setImmediate(resolve));

function captureLogger(): { lines: string[]; logger: Logger } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: pino(stream) };
}

async function boot(opts: {
  nowMs: number;
  stock?: string;
  stockQuantity?: string;
  redis?: FakeRedis;
  mongo?: FakeMongo;
  payment?: PaymentProvider;
  logger?: Logger;
  /** Pass true to inject the direct Mongo recorder instead of the write-behind
   *  queue adapter. Required for audit + cold-restart tests that assert on
   *  immediate Mongo persistence (the worker is not running in test). */
  directAudit?: boolean;
}) {
  const mongo = opts.mongo ?? createFakeMongo();
  // Idempotent by slug — reserving again on a reused mongo returns the same id.
  const saleId = await reserveSaleId(mongo, SALE_SLUG);
  const fake = opts.redis ?? createFakeRedis(opts.stock === undefined ? {} : { stock: opts.stock, saleId });
  const overrides: BootstrapOverrides = {
    env: {
      SALE_START_TIME: SALE_START,
      SALE_END_TIME: SALE_END,
      STOCK_QUANTITY: opts.stockQuantity ?? "100",
    },
    logger: opts.logger ?? pino({ level: "silent" }),
    clock: () => opts.nowMs,
    createRedis: () => fake.client,
    connectRedis: vi.fn(async () => {}),
    disconnectRedis: vi.fn(async () => {}),
    connectMongoDb: vi.fn(async () => {}),
    disconnectMongoDb: vi.fn(async () => {}),
    mongoModelOps: mongo.ops,
    ...(opts.payment === undefined ? {} : { payment: opts.payment }),
    // Bypass the queue adapter for tests that need immediate Mongo writes.
    ...(opts.directAudit
      ? { createOrderAudit: (productId) => createOrderRecorder(productId, mongo.ops.audit) }
      : {}),
  };
  const { app } = await bootstrap(overrides);
  return { fake, mongo, saleId, app };
}

describe("boot seed", () => {
  it("cold boot seeds Product, Sale, SaleProduct, Inventory from env and is idempotent across boots", async () => {
    const mongo = createFakeMongo();
    const first = await boot({ nowMs: IN_WINDOW, mongo, stockQuantity: "5" });
    expect(first.fake.kv.get(stockKeyFor(first.saleId))).toBe("5");
    expect(mongo.products.size).toBe(1);
    expect(mongo.sales.size).toBe(1);
    expect(mongo.saleProducts.size).toBe(1);
    expect(mongo.inventories.size).toBe(1);
    const sale = [...mongo.sales.values()][0];
    expect(sale?.startTime).toEqual(new Date(startMs));
    expect(sale?.stockQuantity).toBe(5);

    // Second boot (same stores): still exactly one of each seed doc.
    await boot({ nowMs: IN_WINDOW, mongo, redis: first.fake, stockQuantity: "5" });
    expect(mongo.products.size).toBe(1);
    expect(mongo.sales.size).toBe(1);
    expect(mongo.saleProducts.size).toBe(1);
    expect(mongo.inventories.size).toBe(1);
  });
});

describe("async Mongo audit + payment after OK", () => {
  it("a 202 accept audits upsert User + Order('confirmed') + one OrderLine (qty 1, unitPrice 0) and charges payment once", async () => {
    const charge = vi.fn(async (email: string) => ({ approved: true, reference: `noop:${email}` }));
    const { mongo } = await boot({ nowMs: IN_WINDOW, stock: "5", payment: { charge }, directAudit: true }).then(
      async (booted) => {
        const res = await request(booted.app)
          .post("/api/order")
          .send({ email: "buyer@example.com" });
        expect(res.status).toBe(202);
        expect(res.body).toEqual({
          success: true,
          email: "buyer@example.com",
          message: "Order accepted.",
        });
        await drain();
        return booted;
      },
    );

    expect(mongo.users.get("buyer@example.com")).toBeDefined();
    expect(mongo.orders).toHaveLength(1);
    const order = mongo.orders[0];
    expect(order?.email).toBe("buyer@example.com");
    expect(order?.status).toBe("confirmed");
    expect(order?.saleId).toBe([...mongo.sales.values()][0]?.id);
    expect(order?.userId).toBe(mongo.users.get("buyer@example.com"));
    expect(mongo.orderLines).toHaveLength(1);
    expect(mongo.orderLines[0]).toEqual({
      orderId: order?.id,
      productId: [...mongo.products.values()][0]?.id,
      quantity: 1,
      unitPrice: 0,
    });
    expect(charge).toHaveBeenCalledExactlyOnceWith("buyer@example.com");
  });

  it("an idempotent retry (200) does not grow the audit trail or charge again", async () => {
    const charge = vi.fn(async (email: string) => ({ approved: true, reference: `noop:${email}` }));
    const { app, mongo } = await boot({ nowMs: IN_WINDOW, stock: "5", payment: { charge }, directAudit: true });
    await request(app).post("/api/order").send({ email: "buyer@example.com" });
    await drain();

    const retry = await request(app).post("/api/order").send({ email: "buyer@example.com" });
    expect(retry.status).toBe(200);
    await drain();
    expect(mongo.orders).toHaveLength(1);
    expect(mongo.orderLines).toHaveLength(1);
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it("rejections and validation failures never write Mongo or charge payment (negative space)", async () => {
    const charge = vi.fn(async (email: string) => ({ approved: true, reference: `noop:${email}` }));
    const { app, mongo } = await boot({ nowMs: IN_WINDOW, stock: "0", payment: { charge } });

    expect((await request(app).post("/api/order").send({ email: "late@x.com" })).status).toBe(409); // sold out
    expect((await request(app).post("/api/order").send({ email: "" })).status).toBe(400); // validation

    const after = await boot({ nowMs: startMs - 1000, stock: "5", payment: { charge } });
    expect((await request(after.app).post("/api/order").send({ email: "early@x.com" })).status).toBe(409); // inactive

    await drain();
    expect(mongo.orders).toHaveLength(0);
    expect(after.mongo.orders).toHaveLength(0);
    expect(charge).not.toHaveBeenCalled();
  });

  it("a rejecting payment provider never alters the 202", async () => {
    const charge = vi.fn(async () => {
      throw new Error("gateway exploded");
    });
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "5", payment: { charge } });
    const res = await request(app).post("/api/order").send({ email: "buyer@example.com" });
    expect(res.status).toBe(202);
    expect(res.body.message).toBe("Order accepted.");
    await drain();
  });
});

describe("Mongo write failure: logged, never rolled back, response unchanged", () => {
  it("failing audit -> exact 202 body, Redis decrement kept, one error log line", async () => {
    const { lines, logger } = captureLogger();
    const { app, fake, saleId, mongo } = await boot({ nowMs: IN_WINDOW, stock: "5", logger, directAudit: true });
    mongo.failingAudit = true;

    const res = await request(app).post("/api/order").send({ email: "unlucky@example.com" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      success: true,
      email: "unlucky@example.com",
      message: "Order accepted.",
    });
    await drain();

    // No rollback: the buyer keeps their unit.
    expect(fake.kv.get(stockKeyFor(saleId))).toBe("4");
    expect(fake.sets.get(ordersKeyFor(saleId))?.has("unlucky@example.com")).toBe(true);
    // The accepted, documented audit undercount.
    expect(mongo.orders).toHaveLength(0);
    // The error is logged.
    const errorLine = lines.find((l) => l.includes("post-accept side effect failed"));
    expect(errorLine).toBeDefined();
    expect(errorLine).toContain('"effect":"audit"');
  });
});

describe("restart safety", () => {
  it("warm restart touches nothing — surviving state wins and STOCK_QUANTITY changes are no-ops", async () => {
    const first = await boot({ nowMs: IN_WINDOW, stock: "5", stockQuantity: "5" });
    await request(first.app).post("/api/order").send({ email: "w-1@x.com" });
    await request(first.app).post("/api/order").send({ email: "w-2@x.com" });
    await drain();
    expect(first.fake.kv.get(stockKeyFor(first.saleId))).toBe("3");

    const writesBefore = { ...first.fake.calls };
    await boot({ nowMs: IN_WINDOW, redis: first.fake, mongo: first.mongo, stockQuantity: "100" });
    expect(first.fake.kv.get(stockKeyFor(first.saleId))).toBe("3");
    expect(orderSetSize(first.fake, first.saleId)).toBe(2);
    expect(first.fake.calls.del).toBe(writesBefore.del);
    expect(first.fake.calls.set).toBe(writesBefore.set);
    expect(first.fake.calls.sAdd).toBe(writesBefore.sAdd);
  });

  it("cold restart rebuilds membership + stock from MongoDB; counts and idempotent retries survive", async () => {
    const first = await boot({ nowMs: IN_WINDOW, stock: "5", stockQuantity: "5", directAudit: true });
    for (const email of ["w-1@x.com", "w-2@x.com", "w-3@x.com"]) {
      const res = await request(first.app).post("/api/order").send({ email });
      expect(res.status).toBe(202);
    }
    await drain();
    expect(first.mongo.orders).toHaveLength(3);

    // Redis is wiped (the cold-restart precondition), API restarts.
    first.fake.flush();
    const second = await boot({
      nowMs: IN_WINDOW,
      redis: first.fake,
      mongo: first.mongo,
      stockQuantity: "5",
      directAudit: true,
    });

    // Membership and stock restored from Mongo truth.
    expect(orderSetMembers(first.fake, first.saleId)).toEqual(["w-1@x.com", "w-2@x.com", "w-3@x.com"]);
    expect(first.fake.kv.get(stockKeyFor(first.saleId))).toBe("2");

    const status = await request(second.app).get("/api/sale/status");
    expect(status.body.stock).toBe(2);
    expect(status.body.status).toBe("active");

    // Idempotent retry survives the restart.
    const retry = await request(second.app).post("/api/order").send({ email: "w-2@x.com" });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({
      success: true,
      email: "w-2@x.com",
      message: "You have already ordered this item.",
    });

    // And the sale continues where it left off.
    const fresh = await request(second.app).post("/api/order").send({ email: "w-4@x.com" });
    expect(fresh.status).toBe(202);
    expect(first.fake.kv.get(stockKeyFor(first.saleId))).toBe("1");
    await drain();
    expect(first.mongo.orders).toHaveLength(4);
  });

  it("restart never heals Mongo from Redis: a dropped audit write stays a permanent undercount", async () => {
    const first = await boot({ nowMs: IN_WINDOW, stock: "5", stockQuantity: "5", directAudit: true });
    await request(first.app).post("/api/order").send({ email: "audited-1@x.com" });
    await request(first.app).post("/api/order").send({ email: "audited-2@x.com" });
    await drain();

    // The crash window: Redis accepted, the Mongo write was lost.
    first.mongo.failingAudit = true;
    const lost = await request(first.app).post("/api/order").send({ email: "lost@x.com" });
    expect(lost.status).toBe(202);
    await drain();
    first.mongo.failingAudit = false;
    expect(first.mongo.orders).toHaveLength(2);
    expect(first.fake.kv.get(stockKeyFor(first.saleId))).toBe("2");

    // Cold restart: Redis is rebuilt FROM Mongo — never the reverse.
    first.fake.flush();
    await boot({ nowMs: IN_WINDOW, redis: first.fake, mongo: first.mongo, stockQuantity: "5" });

    expect(first.mongo.orders).toHaveLength(2); // boot wrote nothing to Mongo
    expect(orderSetMembers(first.fake, first.saleId)).toEqual(["audited-1@x.com", "audited-2@x.com"]);
    expect(first.fake.kv.get(stockKeyFor(first.saleId))).toBe("3"); // 5 - 2: the lost slot is re-issuable
  });

  it("cold rebuild clamps stock:{saleId}:remaining at 0 when confirmed orders exceed STOCK_QUANTITY", async () => {
    const first = await boot({ nowMs: IN_WINDOW, stock: "10", stockQuantity: "10", directAudit: true });
    for (let i = 0; i < 6; i += 1) {
      await request(first.app).post("/api/order").send({ email: `b-${i}@x.com` });
    }
    await drain();
    expect(first.mongo.orders).toHaveLength(6);

    // Operator lowers STOCK_QUANTITY below the confirmed count, Redis wiped.
    first.fake.flush();
    const second = await boot({
      nowMs: IN_WINDOW,
      redis: first.fake,
      mongo: first.mongo,
      stockQuantity: "4",
    });

    expect(first.fake.kv.get(stockKeyFor(first.saleId))).toBe("0"); // clamped, never negative
    expect(orderSetSize(first.fake, first.saleId)).toBe(6);
    const status = await request(second.app).get("/api/sale/status");
    expect(status.body.status).toBe("sold_out");
  });
});
