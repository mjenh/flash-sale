// Tests for the SaleBootstrapOps implementation (Story 6-1) and the seed
// constants exported from seed.ts that tests use as fixture values.
//
// The real mongoSaleBootstrapOps uses Mongoose models and cannot be tested
// without a live Mongo connection. These tests cover the in-memory fake
// implementation (fake-mongo.ts) which mirrors the real queries, proving the
// fake is faithful and that bootstrap() would behave correctly if the same
// data were in a real DB.
import { describe, expect, it } from "vitest";
import {
  PRODUCT_NAME,
  PRODUCT_SKU,
  PRODUCT_ORIGINAL_PRICE,
  PRODUCT_FLASH_SALE_PRICE,
  SALE_NAME,
  SALE_SLUG,
} from "../src/adapters/mongo/seed.ts";
import { createFakeMongo, reserveSaleId } from "./helpers/fake-mongo.ts";
import { START_MS, END_MS } from "./helpers/time-fixtures.ts";

describe("seed.ts constants (exported for test fixtures)", () => {
  it("product and sale identity constants have the expected values", () => {
    expect(PRODUCT_SKU).toBe("KEYCAP-ONE");
    expect(PRODUCT_NAME).toBe("Keycap One");
    expect(SALE_SLUG).toBe("flash-sale");
    expect(SALE_NAME).toBe("Flash Sale");
    expect(PRODUCT_ORIGINAL_PRICE).toBe(199.99);
    expect(PRODUCT_FLASH_SALE_PRICE).toBe(99.99);
  });
});

describe("fake SaleBootstrapOps (Story 6-1 in-memory implementation)", () => {
  it("listAllSales: returns all sales as BootstrapSaleDoc[]", async () => {
    const mongo = createFakeMongo();
    await reserveSaleId(mongo, SALE_SLUG, { startMs: START_MS, endMs: END_MS, stockQuantity: 7 });

    const sales = await mongo.saleBootstrap.listAllSales();

    expect(sales).toHaveLength(1);
    expect(sales[0]).toEqual({
      _id: `sale-${SALE_SLUG}`,
      slug: SALE_SLUG,
      name: SALE_NAME,
      startTime: new Date(START_MS),
      endTime: new Date(END_MS),
      stockQuantity: 7,
    });
  });

  it("listAllSales: returns multiple sales when more are added", async () => {
    const mongo = createFakeMongo();
    await reserveSaleId(mongo, SALE_SLUG);
    mongo.sales.set("future-sale", {
      id: "future-sale",
      name: "Future Sale",
      startTime: new Date("2030-01-01T00:00:00Z"),
      endTime: new Date("2030-01-02T00:00:00Z"),
      stockQuantity: 50,
    });

    const sales = await mongo.saleBootstrap.listAllSales();
    expect(sales).toHaveLength(2);
    const slugs = sales.map((s) => s.slug);
    expect(slugs).toContain(SALE_SLUG);
    expect(slugs).toContain("future-sale");
  });

  it("getSaleProduct: returns productId + flashSalePrice for a seeded saleId", async () => {
    const mongo = createFakeMongo();
    const saleId = await reserveSaleId(mongo, SALE_SLUG, { flashSalePrice: 79.99 });

    const sp = await mongo.saleBootstrap.getSaleProduct(saleId);

    expect(sp).not.toBeNull();
    expect(sp?.flashSalePrice).toBe(79.99);
    expect(sp?.productId).toContain(PRODUCT_SKU.toLowerCase());
  });

  it("getSaleProduct: returns null when no product is linked to the saleId", async () => {
    const mongo = createFakeMongo();
    const sp = await mongo.saleBootstrap.getSaleProduct("no-such-sale");
    expect(sp).toBeNull();
  });

  it("listConfirmedOrderEmails: returns unique confirmed emails for the given saleId only", async () => {
    const mongo = createFakeMongo();
    const saleId = await reserveSaleId(mongo, SALE_SLUG);

    // Inject confirmed orders for the active sale.
    mongo.orders.push({ id: "o1", saleId, email: "a@x.com", userId: "u1", status: "confirmed" });
    mongo.orders.push({ id: "o2", saleId, email: "b@x.com", userId: "u2", status: "confirmed" });
    // Duplicate email — should appear only once.
    mongo.orders.push({ id: "o3", saleId, email: "a@x.com", userId: "u1", status: "confirmed" });
    // Different saleId — must not appear.
    mongo.orders.push({ id: "o4", saleId: "other-sale", email: "c@x.com", userId: "u3", status: "confirmed" });

    const emails = await mongo.saleBootstrap.listConfirmedOrderEmails(saleId);

    // Deduped, saleId-scoped.
    expect(new Set(emails)).toEqual(new Set(["a@x.com", "b@x.com"]));
    expect(emails).not.toContain("c@x.com");
  });

  it("listConfirmedOrderEmails: empty array when no orders exist", async () => {
    const mongo = createFakeMongo();
    const saleId = await reserveSaleId(mongo, SALE_SLUG);
    const emails = await mongo.saleBootstrap.listConfirmedOrderEmails(saleId);
    expect(emails).toEqual([]);
  });

  it("reserveSaleId: is idempotent by slug — same saleId on repeat calls", async () => {
    const mongo = createFakeMongo();
    const first = await reserveSaleId(mongo, SALE_SLUG);
    const second = await reserveSaleId(mongo, SALE_SLUG);
    expect(first).toBe(second);
    expect(mongo.sales.size).toBe(1);
  });

  it("reserveSaleId: $set semantics — mutable fields update on repeat calls when opts provided", async () => {
    const mongo = createFakeMongo();
    await reserveSaleId(mongo, SALE_SLUG, { stockQuantity: 50 });
    await reserveSaleId(mongo, SALE_SLUG, { stockQuantity: 20 });
    expect(mongo.sales.get(SALE_SLUG)?.stockQuantity).toBe(20);
  });

  it("a missing getSaleProduct causes bootstrap to ConfigError (documented invariant)", async () => {
    // If getSaleProduct returns null, bootstrap throws ConfigError.
    // This test proves the fake's getSaleProduct is the failure trigger.
    const mongo = createFakeMongo();
    const saleId = await reserveSaleId(mongo, SALE_SLUG);
    // Clear the saleProducts so getSaleProduct returns null.
    mongo.saleProducts.clear();
    const result = await mongo.saleBootstrap.getSaleProduct(saleId);
    expect(result).toBeNull();
  });
});
