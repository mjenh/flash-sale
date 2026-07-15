// Boot seed + rebuild source. Idempotent upserts of the four seed documents
// (Product, Sale, SaleProduct, Inventory) from env config, strictly before
// listen(); plus the cold-rebuild read (the sale's confirmed Order emails).
//
// Same split as audit.ts: thin one-query ops behind SeedModelOps, tested
// composition in createDomainSeeder.
import { Inventory, Order, Product, Sale, SaleProduct } from "./models.ts";
import type { AppConfig } from "../config.ts";
import type { SaleRefs } from "./audit.ts";

// Default identity values — kept as named exports so existing tests can import
// them as fixture constants. The live seed() path reads from AppConfig, which
// defaults to these strings/numbers when the env vars are unset.
export const SALE_SLUG = "flash-sale";
export const SALE_NAME = "Flash Sale";
export const PRODUCT_SKU = "KEYCAP-ONE";
export const PRODUCT_NAME = "Keycap One";
export const PRODUCT_ORIGINAL_PRICE = 199.99;
export const PRODUCT_FLASH_SALE_PRICE = 99.99;

/** Story 4.5: the shape of a Sale document needed by boot-time active-sale
 *  resolution — structurally identical to `SaleSummary`
 *  (middleware/sale-resolver.ts), duplicated here rather than imported so
 *  this adapter layer doesn't depend on the HTTP middleware layer. */
export interface SeedSaleDoc {
  _id: string;
  slug: string;
  name: string;
  startTime: Date;
  endTime: Date;
  stockQuantity: number;
}

/** Narrow model surface — one mongoose query per op. */
export interface SeedModelOps {
  upsertProduct(sku: string, name: string, originalPrice: number): Promise<string>;
  upsertSale(
    slug: string,
    sale: { name: string; startTime: Date; endTime: Date; stockQuantity: number },
  ): Promise<string>;
  upsertSaleProduct(saleId: string, productId: string, flashSalePrice: number): Promise<void>;
  upsertInventory(productId: string, initialQuantity: number): Promise<void>;
  listConfirmedOrderEmails(saleId: string): Promise<string[]>;
  /** Story 4.5: ALL Sale documents (not just the boot-seeded singleton) —
   *  drives bootstrap.ts's multi-sale-safe active-sale identification and
   *  its v1.1-NFR-5 overlap fail-fast. Today exactly one Sale document ever
   *  exists (the constant-slug singleton this file seeds), but this query
   *  is written generically so a future second Sale document is handled
   *  correctly without changes here. */
  listAllSales(): Promise<SeedSaleDoc[]>;
}

export const mongoSeedModelOps: SeedModelOps = {
  async upsertProduct(sku: string, name: string, originalPrice: number): Promise<string> {
    const product = await Product.findOneAndUpdate(
      { sku },
      // $set updates originalPrice on every boot so env changes take effect;
      // $setOnInsert handles the immutable name only on first creation.
      { $set: { originalPrice }, $setOnInsert: { name } },
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

  async upsertSaleProduct(saleId: string, productId: string, flashSalePrice: number): Promise<void> {
    // $set updates flashSalePrice on every boot so env changes propagate;
    // the filter keys (saleId, productId) become the doc on first insert.
    await SaleProduct.findOneAndUpdate({ saleId, productId }, { $set: { flashSalePrice } }, { upsert: true });
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

  async listAllSales(): Promise<SeedSaleDoc[]> {
    const sales = await Sale.find({}).lean();
    return sales.map((s) => ({
      _id: String(s._id),
      slug: s.slug,
      name: s.name,
      startTime: s.startTime,
      endTime: s.endTime,
      stockQuantity: s.stockQuantity,
    }));
  },
};

export interface DomainSeeder {
  /** Idempotent seed upserts — returns the refs the audit writer needs. */
  seed(config: AppConfig): Promise<SaleRefs>;
  /** Cold-rebuild source: the sale's confirmed Order emails. */
  listConfirmedOrderEmails(saleId: string): Promise<string[]>;
  /** Story 4.5: all Sale documents, for boot-time active-sale resolution. */
  listAllSales(): Promise<SeedSaleDoc[]>;
}

export function createDomainSeeder(ops: SeedModelOps = mongoSeedModelOps): DomainSeeder {
  return {
    async seed(config: AppConfig): Promise<SaleRefs> {
      const productId = await ops.upsertProduct(
        config.productSku,
        config.productName,
        config.originalPrice,
      );
      const saleId = await ops.upsertSale(config.saleSlug, {
        name: config.saleName,
        startTime: new Date(config.saleStartMs),
        endTime: new Date(config.saleEndMs),
        stockQuantity: config.stockQuantity,
      });
      await ops.upsertSaleProduct(saleId, productId, config.flashSalePrice);
      await ops.upsertInventory(productId, config.stockQuantity);
      return { saleId, productId, flashSalePrice: config.flashSalePrice };
    },

    listConfirmedOrderEmails(saleId: string): Promise<string[]> {
      return ops.listConfirmedOrderEmails(saleId);
    },

    listAllSales(): Promise<SeedSaleDoc[]> {
      return ops.listAllSales();
    },
  };
}
