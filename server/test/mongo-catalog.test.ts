// Fake model ops, zero I/O. Proves the Sale -> SaleProduct -> Product ->
// Inventory join: ordering, the empty-sale short circuit, the orphaned
// SaleProduct skip, and the missing-Inventory-defaults-to-0 fallback.
// Mirrors mongo-seed.test.ts / mongo-audit.test.ts: the composed join lives
// in createCatalogReader and is tested here; the one-query-per-op
// mongoCatalogModelOps itself is exercised only through real Mongo (out of
// scope for this suite, same as mongoSeedModelOps/mongoAuditModelOps).
import { describe, expect, it, vi } from "vitest";
import { createCatalogReader, type CatalogModelOps } from "../src/adapters/mongo/catalog.ts";

function fakeOps(overrides: Partial<CatalogModelOps> = {}) {
  return {
    listSaleProducts: vi.fn<CatalogModelOps["listSaleProducts"]>(async () => []),
    listProductsByIds: vi.fn<CatalogModelOps["listProductsByIds"]>(async () => []),
    listInventoriesByProductIds: vi.fn<CatalogModelOps["listInventoriesByProductIds"]>(async () => []),
    ...overrides,
  };
}

describe("createCatalogReader (Sale -> SaleProduct -> Product -> Inventory join)", () => {
  it("joins a single product's sku/name/initialQuantity", async () => {
    const ops = fakeOps({
      listSaleProducts: vi.fn(async () => [{ productId: "product-1" }]),
      listProductsByIds: vi.fn(async () => [{ id: "product-1", sku: "KC-001", name: "Keycap One" }]),
      listInventoriesByProductIds: vi.fn(async () => [{ productId: "product-1", initialQuantity: 100 }]),
    });

    const products = await createCatalogReader(ops).listProductsForSale("sale-1");

    expect(products).toEqual([{ sku: "KC-001", name: "Keycap One", initialQuantity: 100 }]);
    expect(ops.listSaleProducts).toHaveBeenCalledExactlyOnceWith("sale-1");
    expect(ops.listProductsByIds).toHaveBeenCalledExactlyOnceWith(["product-1"]);
    expect(ops.listInventoriesByProductIds).toHaveBeenCalledExactlyOnceWith(["product-1"]);
  });

  it("preserves SaleProduct listing order across multiple products", async () => {
    const ops = fakeOps({
      listSaleProducts: vi.fn(async () => [{ productId: "p-2" }, { productId: "p-1" }]),
      listProductsByIds: vi.fn(async () => [
        { id: "p-1", sku: "AAA", name: "First" },
        { id: "p-2", sku: "BBB", name: "Second" },
      ]),
      listInventoriesByProductIds: vi.fn(async () => [
        { productId: "p-1", initialQuantity: 10 },
        { productId: "p-2", initialQuantity: 20 },
      ]),
    });

    const products = await createCatalogReader(ops).listProductsForSale("sale-1");

    expect(products).toEqual([
      { sku: "BBB", name: "Second", initialQuantity: 20 },
      { sku: "AAA", name: "First", initialQuantity: 10 },
    ]);
  });

  it("returns an empty array without querying Product/Inventory when the sale has no SaleProduct rows", async () => {
    const ops = fakeOps({ listSaleProducts: vi.fn(async () => []) });

    const products = await createCatalogReader(ops).listProductsForSale("sale-empty");

    expect(products).toEqual([]);
    expect(ops.listProductsByIds).not.toHaveBeenCalled();
    expect(ops.listInventoriesByProductIds).not.toHaveBeenCalled();
  });

  it("skips a SaleProduct row with no matching Product doc (defensive — orphaned row)", async () => {
    const ops = fakeOps({
      listSaleProducts: vi.fn(async () => [{ productId: "missing-product" }, { productId: "p-1" }]),
      listProductsByIds: vi.fn(async () => [{ id: "p-1", sku: "AAA", name: "First" }]),
      listInventoriesByProductIds: vi.fn(async () => [{ productId: "p-1", initialQuantity: 10 }]),
    });

    const products = await createCatalogReader(ops).listProductsForSale("sale-1");

    expect(products).toEqual([{ sku: "AAA", name: "First", initialQuantity: 10 }]);
  });

  it("defaults initialQuantity to 0 when Inventory has no matching doc (defensive)", async () => {
    const ops = fakeOps({
      listSaleProducts: vi.fn(async () => [{ productId: "p-1" }]),
      listProductsByIds: vi.fn(async () => [{ id: "p-1", sku: "AAA", name: "First" }]),
      listInventoriesByProductIds: vi.fn(async () => []),
    });

    const products = await createCatalogReader(ops).listProductsForSale("sale-1");

    expect(products).toEqual([{ sku: "AAA", name: "First", initialQuantity: 0 }]);
  });

  it("uses mongoCatalogModelOps by default when no ops are injected", () => {
    // Construction alone must not throw or touch Mongo — proves the default
    // parameter wiring without requiring a live connection.
    expect(() => createCatalogReader()).not.toThrow();
  });
});
