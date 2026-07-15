// Boot-time DB reads: the three queries bootstrap() needs to transition from
// "connect to Mongo" to "start serving". Replaces the old seeder.seed(config)
// write path — sale, product, and inventory data is now pre-existing in the DB
// (provisioned by scripts/seed-db.ts) rather than upserted from env vars on
// every boot.
//
// Three operations, one query each:
//   listAllSales()              → Sale[]   (for selectActiveSale + overlap check)
//   getSaleProduct(saleId)      → { productId, flashSalePrice } | null
//   listConfirmedOrderEmails(saleId) → string[]  (for cold-rebuild source)
//
// SaleSummary (middleware/sale-resolver.ts) is intentionally not imported here
// — adapter layer must not depend on the HTTP middleware layer. BootstrapSaleDoc
// is structurally identical; bootstrap.ts passes it to selectActiveSale() which
// accepts SaleSummary[] by structural subtyping.
import { Order, Product, Sale, SaleProduct } from "./models.ts";

/** Subset of a Sale document needed by the boot sequence. Structurally
 *  identical to SaleSummary (middleware/sale-resolver.ts), duplicated here
 *  so this adapter layer stays independent of the HTTP middleware layer. */
export interface BootstrapSaleDoc {
  _id: string;
  slug: string;
  name: string;
  startTime: Date;
  endTime: Date;
  stockQuantity: number;
}

/** Narrow read-only surface — one Mongoose query per op. */
export interface SaleBootstrapOps {
  /** All Sale documents — drives boot-time active-sale selection and the
   *  overlap fail-fast guard (v1.1-NFR-5). */
  listAllSales(): Promise<BootstrapSaleDoc[]>;
  /** The first SaleProduct row for the given saleId (v1.1 has exactly one
   *  product per sale). Returns null if no product is configured. */
  getSaleProduct(saleId: string): Promise<{ productId: string; flashSalePrice: number } | null>;
  /** Cold-rebuild source: the confirmed Order emails for this sale. */
  listConfirmedOrderEmails(saleId: string): Promise<string[]>;
}

export const mongoSaleBootstrapOps: SaleBootstrapOps = {
  async listAllSales(): Promise<BootstrapSaleDoc[]> {
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

  async getSaleProduct(saleId: string): Promise<{ productId: string; flashSalePrice: number } | null> {
    const sp = await SaleProduct.findOne({ saleId }).lean();
    if (sp === null) {
      return null;
    }
    return {
      productId: String(sp.productId),
      flashSalePrice: sp.flashSalePrice ?? 0,
    };
  },

  async listConfirmedOrderEmails(saleId: string): Promise<string[]> {
    const emails = await Order.distinct("email", { saleId, status: "confirmed" });
    return emails.map(String);
  },
};
