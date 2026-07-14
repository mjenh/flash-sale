// Boot seed + rebuild source. Idempotent upserts of the four seed documents
// (Product, Sale, SaleProduct, Inventory) from env config, strictly before
// listen(); plus the cold-rebuild read (the sale's confirmed Order emails).
//
// Same split as audit.ts: thin one-query ops behind SeedModelOps, tested
// composition in createDomainSeeder.
import { Inventory, Order, Product, Sale, SaleProduct } from "./models.ts";
import type { AppConfig } from "../config.ts";
import type { SaleRefs } from "./audit.ts";

// Single-sale system: the sale keys on a constant slug and its window/stock
// are $set from env each boot so the durable record mirrors current config.
export const SALE_SLUG = "flash-sale";
export const SALE_NAME = "Flash Sale";
export const PRODUCT_SKU = "KEYCAP-ONE";
export const PRODUCT_NAME = "Keycap One";

/** Narrow model surface — one mongoose query per op. */
export interface SeedModelOps {
  upsertProduct(sku: string, name: string): Promise<string>;
  upsertSale(
    slug: string,
    sale: { name: string; startTime: Date; endTime: Date; stockQuantity: number },
  ): Promise<string>;
  upsertSaleProduct(saleId: string, productId: string): Promise<void>;
  upsertInventory(productId: string, initialQuantity: number): Promise<void>;
  listConfirmedOrderEmails(saleId: string): Promise<string[]>;
}

export const mongoSeedModelOps: SeedModelOps = {
  async upsertProduct(sku: string, name: string): Promise<string> {
    const product = await Product.findOneAndUpdate(
      { sku },
      { $setOnInsert: { name } },
      { upsert: true, new: true },
    );
    if (product === null) {
      throw new Error("Product upsert returned null");
    }
    return String(product._id);
  },

  async upsertSale(slug, { name, startTime, endTime, stockQuantity }): Promise<string> {
    const sale = await Sale.findOneAndUpdate(
      { slug },
      { $set: { name, startTime, endTime, stockQuantity } },
      { upsert: true, new: true },
    );
    if (sale === null) {
      throw new Error("Sale upsert returned null");
    }
    return String(sale._id);
  },

  async upsertSaleProduct(saleId: string, productId: string): Promise<void> {
    // Empty update: with upsert, the filter's equality fields become the doc.
    await SaleProduct.findOneAndUpdate({ saleId, productId }, {}, { upsert: true });
  },

  async upsertInventory(productId: string, initialQuantity: number): Promise<void> {
    // $setOnInsert only — Inventory is seeded once, never ticked per order.
    await Inventory.findOneAndUpdate(
      { productId },
      { $setOnInsert: { initialQuantity } },
      { upsert: true },
    );
  },

  async listConfirmedOrderEmails(saleId: string): Promise<string[]> {
    const emails = await Order.distinct("email", { saleId, status: "confirmed" });
    return emails.map(String);
  },
};

export interface DomainSeeder {
  /** Idempotent seed upserts — returns the refs the audit writer needs. */
  seed(config: AppConfig): Promise<SaleRefs>;
  /** Cold-rebuild source: the sale's confirmed Order emails. */
  listConfirmedOrderEmails(saleId: string): Promise<string[]>;
}

export function createDomainSeeder(ops: SeedModelOps = mongoSeedModelOps): DomainSeeder {
  return {
    async seed(config: AppConfig): Promise<SaleRefs> {
      const productId = await ops.upsertProduct(PRODUCT_SKU, PRODUCT_NAME);
      const saleId = await ops.upsertSale(SALE_SLUG, {
        name: SALE_NAME,
        startTime: new Date(config.saleStartMs),
        endTime: new Date(config.saleEndMs),
        stockQuantity: config.stockQuantity,
      });
      await ops.upsertSaleProduct(saleId, productId);
      await ops.upsertInventory(productId, config.stockQuantity);
      return { saleId, productId };
    },

    listConfirmedOrderEmails(saleId: string): Promise<string[]> {
      return ops.listConfirmedOrderEmails(saleId);
    },
  };
}
