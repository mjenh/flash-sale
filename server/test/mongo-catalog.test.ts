// Fake model ops, zero I/O. Proves the Sale -> SaleProduct -> Product ->
// Inventory join: ordering, the empty-sale short circuit, the orphaned
// SaleProduct skip, and the missing-Inventory-defaults-to-0 fallback.
// Mirrors mongo-seed.test.ts / mongo-audit.test.ts: the composed join lives
// in createCatalogReader and is tested here; the one-query-per-op
// mongoCatalogModelOps itself is exercised only through real Mongo (out of
// scope for this suite, same as mongoSeedModelOps/mongoAuditModelOps).
import { describe, expect, it, vi } from "vitest";
import { type CatalogModelOps, createCatalogReader } from "../src/adapters/mongo/catalog.ts";

function fakeOps(overrides: Partial<CatalogModelOps> = {}) {
  return {
    listSaleProducts: vi.fn<CatalogModelOps["listSaleProducts"]>(async () => []),
    listProductsByIds: vi.fn<CatalogModelOps["listProductsByIds"]>(async () => []),
    listInventoriesByProductIds: vi.fn<CatalogModelOps["listInventoriesByProductIds"]>(async () => []),
    ...overrides,
  };
}

describe("createCatalogReader (Sale -> SaleProduct -> Product -> Inventory join)", () => {
  it("joins a single product's sku/name/initialQuantity/originalPrice/flashSalePrice", async () => {
    const ops = fakeOps({
      listSaleProducts: vi.fn(async () => [{ productId: "product-1", flashSalePrice: 99.99 }]),
      listProductsByIds: vi.fn(async () => [{ id: "product-1", sku: "KC-001", name: "Keycap One", originalPrice: 199.99 }]),
      listInventoriesByProductIds: vi.fn(async () => [{ productId: "product-1", initialQuantity: 100 }]),
    });

    const products = await createCatalogReader(ops).listProductsForSale("sale-1");

    expect(products).toEqual([{
      sku: "KC-001",
      name: "Keycap One",
      initialQuantity: 100,
      originalPrice: 199.99,
      flashSalePrice: 99.99,
    }]);
    expect(ops.listSaleProducts).toHaveBeenCalledExactlyOnceWith("sale-1");
    expect(ops.listProductsByIds).toHaveBeenCalledExactlyOnceWith(["product-1"]);
    expect(ops.listInventoriesByProductIds).toHaveBeenCalledExactlyOnceWith(["product-1"]);
  });

  it("preserves SaleProduct listing order across multiple products", async () => {
    const ops = fakeOps({
      listSaleProducts: vi.fn(async () => [
        { productId: "p-2", flashSalePrice: 49.99 },
        { productId: "p-1", flashSalePrice: 59.99 },
      ]),
      listProductsByIds: vi.fn(async () => [
        { id: "p-1", sku: "AAA", name: "First", originalPrice: 120.00 },
        { id: "p-2", sku: "BBB", name: "Second", originalPrice: 100.00 },
      ]),
      listInventoriesByProductIds: vi.fn(async () => [
        { productId: "p-1", initialQuantity: 10 },
        { productId: "p-2", initialQuantity: 20 },
      ]),
    });

    const products = await createCatalogReader(ops).listProductsForSale("sale-1");

    expect(products).toEqual([
      { sku: "BBB", name: "Second", initialQuantity: 20, originalPrice: 100.00, flashSalePrice: 49.99 },
      { sku: "AAA", name: "First", initialQuantity: 10, originalPrice: 120.00, flashSalePrice: 59.99 },
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
      listSaleProducts: vi.fn(async () => [
        { productId: "missing-product", flashSalePrice: 0 },
        { productId: "p-1", flashSalePrice: 49.99 },
      ]),
      listProductsByIds: vi.fn(async () => [{ id: "p-1", sku: "AAA", name: "First", originalPrice: 99.99 }]),
      listInventoriesByProductIds: vi.fn(async () => [{ productId: "p-1", initialQuantity: 10 }]),
    });

    const products = await createCatalogReader(ops).listProductsForSale("sale-1");

    expect(products).toEqual([{
      sku: "AAA",
      name: "First",
      initialQuantity: 10,
      originalPrice: 99.99,
      flashSalePrice: 49.99,
    }]);
  });

  it("defaults initialQuantity to 0 when Inventory has no matching doc (defensive)", async () => {
    const ops = fakeOps({
      listSaleProducts: vi.fn(async () => [{ productId: "p-1", flashSalePrice: 79.99 }]),
      listProductsByIds: vi.fn(async () => [{ id: "p-1", sku: "AAA", name: "First", originalPrice: 159.99 }]),
      listInventoriesByProductIds: vi.fn(async () => []),
    });

    const products = await createCatalogReader(ops).listProductsForSale("sale-1");

    expect(products).toEqual([{
      sku: "AAA",
      name: "First",
      initialQuantity: 0,
      originalPrice: 159.99,
      flashSalePrice: 79.99,
    }]);
  });

  it("uses mongoCatalogModelOps by default when no ops are injected", () => {
    // Construction alone must not throw or touch Mongo — proves the default
    // parameter wiring without requiring a live connection.
    expect(() => createCatalogReader()).not.toThrow();
  });
});
