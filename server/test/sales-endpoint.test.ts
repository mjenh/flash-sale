// Integration tests for the v1.1 slug-scoped routes — /api/sales/:slug/*
// and the /api/sales/active discovery endpoint. Booted through the REAL
// bootstrap() with the same in-memory fakes as the v1.0 endpoint tests.
// Every test verifies that the slug-scoped routes produce identical results
// to the v1.0 alias routes.
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { pino } from "pino";
import { bootstrap, type BootstrapOverrides } from "../src/bootstrap.ts";
import type { SaleLookupOps } from "../src/middleware/sale-resolver.ts";
import { PRODUCT_NAME, PRODUCT_SKU, SALE_NAME, SALE_SLUG } from "../src/adapters/mongo/seed.ts";
import { createFakeRedis, stockKeyFor, type FakeRedis } from "./helpers/fake-redis.ts";
import { addCatalogProduct, createFakeMongo, reserveSaleId } from "./helpers/fake-mongo.ts";

const SALE_START = "2026-07-10T04:00:00Z";
const SALE_END = "2026-07-10T05:00:00Z";
const startMs = Date.parse(SALE_START);
const endMs = Date.parse(SALE_END);
const IN_WINDOW = startMs + 1000;

async function boot(opts: {
  nowMs: number;
  stock?: string;
  stockQuantity?: string;
  /** Runs after the saleId is reserved but before bootstrap() seeds the
   *  default product — lets tests add extra catalog products via
   *  addCatalogProduct() ahead of the real seeder's own upsert. */
  beforeBootstrap?: (mongo: ReturnType<typeof createFakeMongo>, saleId: string) => Promise<void>;
  /** Story 5.3: overrides the sale-resolver's lookup ops entirely — used to
   *  simulate "no sales exist" for GET /api/sales/active's 404 branch, a
   *  state the normal boot path can never reach (seed() always upserts one
   *  Sale document before this override would matter for anything else). */
  saleLookupOps?: SaleLookupOps;
}) {
  const mongo = createFakeMongo();
  const saleId = await reserveSaleId(mongo, SALE_SLUG);
  await opts.beforeBootstrap?.(mongo, saleId);
  const fake: FakeRedis = createFakeRedis(opts.stock === undefined ? {} : { stock: opts.stock, saleId });
  const overrides: BootstrapOverrides = {
    env: {
      SALE_START_TIME: SALE_START,
      SALE_END_TIME: SALE_END,
      STOCK_QUANTITY: opts.stockQuantity ?? "100",
    },
    logger: pino({ level: "silent" }),
    clock: () => opts.nowMs,
    createRedis: () => fake.client,
    connectRedis: vi.fn(async () => {}),
    disconnectRedis: vi.fn(async () => {}),
    connectMongoDb: vi.fn(async () => {}),
    disconnectMongoDb: vi.fn(async () => {}),
    mongoModelOps: mongo.ops,
    saleLookupOps: opts.saleLookupOps,
  };
  const { app } = await bootstrap(overrides);
  return { fake, mongo, saleId, app };
}

describe("GET /api/sales/active (discovery endpoint)", () => {
  it("returns the active sale slug", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "50" });
    const res = await request(app).get("/api/sales/active");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, slug: "flash-sale" });
  });

  it("returns the sale slug even outside the window (fallback to nearest)", async () => {
    const { app } = await boot({ nowMs: startMs - 60_000, stock: "100" });
    const res = await request(app).get("/api/sales/active");
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("flash-sale");
  });

  // Story 5.3 (v1.1-FR-6/AC1): "No sales configured." — a state the normal
  // boot path can never produce (seed() always upserts one Sale document),
  // reached here only by overriding the resolver's lookup ops directly.
  it("returns 404 'No sales configured.' when the resolver finds no sale", async () => {
    const { app } = await boot({
      nowMs: IN_WINDOW,
      stock: "50",
      saleLookupOps: {
        async findBySlug() {
          return null;
        },
        async findActiveSale() {
          return null;
        },
      },
    });
    const res = await request(app).get("/api/sales/active");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: "No sales configured." });
  });
});

describe("GET /api/sales/:slug (sale details with inventory, Story 4.3)", () => {
  it("returns sale info + the joined product with remaining from Redis (AC1)", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "42" });
    const res = await request(app).get("/api/sales/flash-sale");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      sale: {
        slug: "flash-sale",
        name: SALE_NAME,
        startTime: "2026-07-10T04:00:00.000Z",
        endTime: "2026-07-10T05:00:00.000Z",
        stockQuantity: 100,
        products: [
          { sku: PRODUCT_SKU, name: PRODUCT_NAME, initialQuantity: 100, remaining: 42 },
        ],
      },
    });
  });

  it("joins multiple products for the sale, each carrying the sale's remaining stock (AC1, AC4)", async () => {
    const { app } = await boot({
      nowMs: IN_WINDOW,
      stock: "7",
      beforeBootstrap: async (mongo, saleId) => {
        await addCatalogProduct(mongo, saleId, { sku: "EXTRA-1", name: "Extra Widget", initialQuantity: 25 });
      },
    });

    const res = await request(app).get("/api/sales/flash-sale");
    expect(res.status).toBe(200);
    // beforeBootstrap adds EXTRA-1 before bootstrap()'s own seeder links the
    // default KEYCAP-ONE product, so SaleProduct listing order (and thus the
    // response order) has EXTRA-1 first — proving the join preserves
    // SaleProduct order rather than sorting or reordering by sku/name.
    expect(res.body.sale.products).toEqual([
      { sku: "EXTRA-1", name: "Extra Widget", initialQuantity: 25, remaining: 7 },
      { sku: PRODUCT_SKU, name: PRODUCT_NAME, initialQuantity: 100, remaining: 7 },
    ]);
  });

  it("degrades gracefully when Redis is unreachable — remaining: null, sale/product details unaffected (AC3)", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "50" });
    fake.failing = true;

    const res = await request(app).get("/api/sales/flash-sale");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      sale: {
        slug: "flash-sale",
        name: SALE_NAME,
        startTime: "2026-07-10T04:00:00.000Z",
        endTime: "2026-07-10T05:00:00.000Z",
        stockQuantity: 100,
        products: [
          { sku: PRODUCT_SKU, name: PRODUCT_NAME, initialQuantity: 100, remaining: null },
        ],
      },
    });
  });

  it("returns 404 for an unknown slug (AC2)", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "50" });
    const res = await request(app).get("/api/sales/nonexistent");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Sale not found." });
  });
});

describe("GET /api/sales/:slug/status", () => {
  it("returns the same status as the v1.0 /api/sale/status", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "37" });

    const v10 = await request(app).get("/api/sale/status");
    const v11 = await request(app).get("/api/sales/flash-sale/status");

    expect(v10.status).toBe(200);
    expect(v11.status).toBe(200);
    expect(v11.body).toEqual(v10.body);
    expect(v11.body).toEqual({
      success: true,
      status: "active",
      stock: 37,
      startTime: "2026-07-10T04:00:00.000Z",
      endTime: "2026-07-10T05:00:00.000Z",
    });
  });

  it("returns 404 for an unknown slug", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "50" });
    const res = await request(app).get("/api/sales/nonexistent/status");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Sale not found." });
  });

  it("reports upcoming before the window", async () => {
    const { app } = await boot({ nowMs: startMs - 60_000, stock: "100" });
    const res = await request(app).get("/api/sales/flash-sale/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("upcoming");
  });

  it("reports ended at the exact end boundary", async () => {
    const { app } = await boot({ nowMs: endMs, stock: "12" });
    const res = await request(app).get("/api/sales/flash-sale/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ended");
  });

  it("reports sold_out at stock 0 inside the window", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "0" });
    const res = await request(app).get("/api/sales/flash-sale/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sold_out");
  });

  it("fails closed with 503 when Redis is down", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "50" });
    fake.failing = true;
    const res = await request(app).get("/api/sales/flash-sale/status");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: "Service temporarily unavailable." });
  });
});

describe("POST /api/sales/:slug/order", () => {
  it("201 for a new email inside the window — identical to v1.0", async () => {
    const { fake, saleId, app } = await boot({ nowMs: IN_WINDOW, stock: "3" });

    const res = await request(app)
      .post("/api/sales/flash-sale/order")
      .send({ email: "buyer@example.com" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      success: true,
      email: "buyer@example.com",
      message: "Order successful.",
    });
    expect(fake.kv.get(stockKeyFor(saleId))).toBe("2");
  });

  it("200 already for a retry — identical to v1.0", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "3" });

    await request(app).post("/api/sales/flash-sale/order").send({ email: "buyer@example.com" });
    const retry = await request(app)
      .post("/api/sales/flash-sale/order")
      .send({ email: "buyer@example.com" });

    expect(retry.status).toBe(200);
    expect(retry.body.message).toBe("You have already ordered this item.");
  });

  it("409 sold out at stock 0 inside the window", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "0" });
    const res = await request(app)
      .post("/api/sales/flash-sale/order")
      .send({ email: "late@example.com" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: "Item is sold out." });
  });

  it("409 inactive outside the window", async () => {
    const { app } = await boot({ nowMs: startMs - 1000, stock: "50" });
    const res = await request(app)
      .post("/api/sales/flash-sale/order")
      .send({ email: "early@example.com" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: "Sale is not active." });
  });

  it("400 for missing email", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    const res = await request(app).post("/api/sales/flash-sale/order").send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });

  it("returns 404 for an unknown slug", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    const res = await request(app)
      .post("/api/sales/nonexistent/order")
      .send({ email: "buyer@example.com" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Sale not found." });
  });
});

describe("GET /api/sales/:slug/order/:email", () => {
  it("200 ordered:true after placing an order via the slug-scoped route", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    await request(app).post("/api/sales/flash-sale/order").send({ email: "winner@example.com" });

    const res = await request(app).get("/api/sales/flash-sale/order/winner@example.com");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ordered: true, email: "winner@example.com" });
  });

  it("200 ordered:false for an email with no order", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    const res = await request(app).get("/api/sales/flash-sale/order/nobody@example.com");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ordered: false, email: "nobody@example.com" });
  });

  it("400 for missing email parameter", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    const res = await request(app).get("/api/sales/flash-sale/order");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });

  it("returns 404 for an unknown slug", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    const res = await request(app).get("/api/sales/nonexistent/order/buyer@example.com");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Sale not found." });
  });
});

describe("v1.0 alias routes still work (req.sale is set by forActiveSale middleware)", () => {
  it("GET /api/sale/status is identical to GET /api/sales/flash-sale/status", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "37" });

    const v10 = await request(app).get("/api/sale/status");
    const v11 = await request(app).get("/api/sales/flash-sale/status");
    expect(v10.body).toEqual(v11.body);
  });

  it("POST /api/order is identical to POST /api/sales/flash-sale/order", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "5" });

    const v10 = await request(app).post("/api/order").send({ email: "alias@example.com" });
    expect(v10.status).toBe(201);

    // The order placed via v1.0 is visible via v1.1 order check.
    const check = await request(app).get("/api/sales/flash-sale/order/alias@example.com");
    expect(check.status).toBe(200);
    expect(check.body.ordered).toBe(true);
  });

  it("GET /api/order/:email is identical to GET /api/sales/flash-sale/order/:email", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    await request(app).post("/api/order").send({ email: "cross@example.com" });

    const v10 = await request(app).get("/api/order/cross@example.com");
    const v11 = await request(app).get("/api/sales/flash-sale/order/cross@example.com");
    expect(v10.body).toEqual(v11.body);
  });
});

describe("reserved slug 'active' does not shadow the discovery endpoint", () => {
  it("GET /api/sales/active returns discovery response, not a 404", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "50" });
    const res = await request(app).get("/api/sales/active");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, slug: "flash-sale" });
  });

  it("GET /api/sales/active/status returns 404 (active is not a real sale slug)", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "50" });
    const res = await request(app).get("/api/sales/active/status");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Sale not found." });
  });
});
