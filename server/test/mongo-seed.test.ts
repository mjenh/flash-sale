// Fake model ops, zero I/O. Proves the four idempotent upserts derive
// exactly from AppConfig, thread the seeded ids into the join docs, and
// return the SaleRefs the audit writer and cold rebuild consume.
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/adapters/config.ts";
import {
  createDomainSeeder,
  PRODUCT_NAME,
  PRODUCT_SKU,
  SALE_NAME,
  SALE_SLUG,
  type SeedModelOps,
} from "../src/adapters/mongo/seed.ts";

const config = loadConfig({
  SALE_START_TIME: "2026-07-10T04:00:00Z",
  SALE_END_TIME: "2026-07-10T05:00:00Z",
  STOCK_QUANTITY: "7",
});

function fakeOps(overrides: Partial<SeedModelOps> = {}) {
  return {
    upsertProduct: vi.fn(async () => "product-1"),
    upsertSale: vi.fn(async () => "sale-1"),
    upsertSaleProduct: vi.fn(async () => {}),
    upsertInventory: vi.fn(async () => {}),
    listConfirmedOrderEmails: vi.fn(async () => ["a@x.com", "b@x.com"]),
    ...overrides,
  };
}

describe("createDomainSeeder (boot seed)", () => {
  it("upserts Product, Sale, SaleProduct, Inventory from env config and returns the refs", async () => {
    const ops = fakeOps();
    const refs = await createDomainSeeder(ops).seed(config);

    expect(ops.upsertProduct).toHaveBeenCalledExactlyOnceWith(PRODUCT_SKU, PRODUCT_NAME);
    expect(ops.upsertSale).toHaveBeenCalledExactlyOnceWith(SALE_SLUG, {
      name: SALE_NAME,
      startTime: new Date(config.saleStartMs),
      endTime: new Date(config.saleEndMs),
      stockQuantity: 7,
    });
    expect(ops.upsertSaleProduct).toHaveBeenCalledExactlyOnceWith("sale-1", "product-1");
    expect(ops.upsertInventory).toHaveBeenCalledExactlyOnceWith("product-1", 7);
    expect(refs).toEqual({ saleId: "sale-1", productId: "product-1" });
  });

  it("stable identities: the sku, slug, and name are constants (single-sale system)", () => {
    expect(PRODUCT_SKU).toBe("KEYCAP-ONE");
    expect(SALE_SLUG).toBe("flash-sale");
    expect(SALE_NAME).toBe("Flash Sale");
  });

  it("listConfirmedOrderEmails passes through to the model op with the saleId", async () => {
    const ops = fakeOps();
    await expect(createDomainSeeder(ops).listConfirmedOrderEmails("sale-1")).resolves.toEqual([
      "a@x.com",
      "b@x.com",
    ]);
    expect(ops.listConfirmedOrderEmails).toHaveBeenCalledExactlyOnceWith("sale-1");
  });

  it("a seed-op failure rejects boot (fail fast before listen())", async () => {
    const boom = new Error("mongo down");
    const ops = fakeOps({
      upsertSale: vi.fn(async () => {
        throw boom;
      }),
    });
    await expect(createDomainSeeder(ops).seed(config)).rejects.toBe(boom);
    expect(ops.upsertSaleProduct).not.toHaveBeenCalled();
  });
});
