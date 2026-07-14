// Mongo adapter for the Sale -> SaleProduct -> Product -> Inventory join used
// by the sale details endpoint (GET /api/sales/:slug, Story 4.3). Read-only;
// never invoked outside that handler, never on the order-accept path.
//
// Same split as audit.ts/seed.ts: thin one-query-per-op mongoose calls
// behind CatalogModelOps, the join itself composed + unit-tested (with fake
// ops) in createCatalogReader. Three queries instead of one aggregation
// pipeline — the per-sale product list is small and fixed-cardinality (v1.1
// still ships one product per sale), so a pipeline buys nothing here.
import { Inventory, Product, SaleProduct } from "./models.ts";

export interface CatalogProduct {
  sku: string;
  name: string;
  initialQuantity: number;
}

interface RawSaleProduct {
  productId: string;
}

interface RawProduct {
  id: string;
  sku: string;
  name: string;
}

interface RawInventory {
  productId: string;
  initialQuantity: number;
}

/** Narrow model surface — one mongoose query per op. */
export interface CatalogModelOps {
  listSaleProducts(saleId: string): Promise<RawSaleProduct[]>;
  listProductsByIds(productIds: string[]): Promise<RawProduct[]>;
  listInventoriesByProductIds(productIds: string[]): Promise<RawInventory[]>;
}

export const mongoCatalogModelOps: CatalogModelOps = {
  async listSaleProducts(saleId: string): Promise<RawSaleProduct[]> {
    const docs = await SaleProduct.find({ saleId }).lean();
    return docs.map((doc) => ({ productId: String(doc.productId) }));
  },

  async listProductsByIds(productIds: string[]): Promise<RawProduct[]> {
    const docs = await Product.find({ _id: { $in: productIds } }).lean();
    return docs.map((doc) => ({ id: String(doc._id), sku: doc.sku, name: doc.name }));
  },

  async listInventoriesByProductIds(productIds: string[]): Promise<RawInventory[]> {
    const docs = await Inventory.find({ productId: { $in: productIds } }).lean();
    return docs.map((doc) => ({
      productId: String(doc.productId),
      initialQuantity: doc.initialQuantity,
    }));
  },
};

export interface CatalogReader {
  /** Sale -> SaleProduct -> Product -> Inventory join, ordered by
   *  SaleProduct listing order. A SaleProduct row with no matching Product
   *  doc is skipped (defensive — should not happen, seed.ts always upserts
   *  Product before SaleProduct). A missing Inventory doc defaults
   *  initialQuantity to 0 (defensive — seed.ts always upserts Inventory
   *  alongside SaleProduct). */
  listProductsForSale(saleId: string): Promise<CatalogProduct[]>;
}

export function createCatalogReader(ops: CatalogModelOps = mongoCatalogModelOps): CatalogReader {
  return {
    async listProductsForSale(saleId: string): Promise<CatalogProduct[]> {
      const saleProducts = await ops.listSaleProducts(saleId);
      if (saleProducts.length === 0) {
        return [];
      }
      const productIds = saleProducts.map((sp) => sp.productId);
      const [products, inventories] = await Promise.all([
        ops.listProductsByIds(productIds),
        ops.listInventoriesByProductIds(productIds),
      ]);
      const productById = new Map(products.map((p) => [p.id, p]));
      const inventoryByProductId = new Map(inventories.map((inv) => [inv.productId, inv.initialQuantity]));

      const result: CatalogProduct[] = [];
      for (const sp of saleProducts) {
        const product = productById.get(sp.productId);
        if (product === undefined) {
          continue;
        }
        result.push({
          sku: product.sku,
          name: product.name,
          initialQuantity: inventoryByProductId.get(sp.productId) ?? 0,
        });
      }
      return result;
    },
  };
}
