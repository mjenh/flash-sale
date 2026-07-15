// Async Mongo audit writer — Redis decides, MongoDB records. Invoked only
// after the order script returns OK; never read on any request path; never
// rolled back on failure (the service logs and continues).
//
// The one-query-per-op mongoose calls live behind AuditModelOps;
// createOrderRecorder holds the ordering + duplicate-key semantics and is
// fully unit-tested with fake ops.
//
// Story 4.4: recordOrder(saleId, email) takes saleId per call (from
// req.sale._id via the order service's SaleContext) rather than a
// bootstrap-frozen SaleRefs.saleId — createOrderRecorder now only closes
// over productId, since v1.1 still ships exactly one product per sale
// (Story 4.3) and there is no per-request product resolution yet.
import { Order, OrderLine, User } from "./models.ts";
import type { OrderAuditPort } from "../../services/order.ts";

/** Boot-seeded document ids (strings — mongoose casts back to ObjectId). */
export interface SaleRefs {
  saleId: string;
  productId: string;
  /** The active flash-sale price at boot — snapshotted into every order line. */
  flashSalePrice: number;
}

/** Narrow model surface — one mongoose query per op. */
export interface AuditModelOps {
  upsertUser(identifier: string): Promise<string>;
  insertConfirmedOrder(doc: { saleId: string; email: string; userId: string }): Promise<string>;
  insertOrderLine(doc: {
    orderId: string;
    productId: string;
    quantity: number;
    unitPrice: number;
  }): Promise<void>;
}

export const mongoAuditModelOps: AuditModelOps = {
  async upsertUser(identifier: string): Promise<string> {
    const user = await User.findOneAndUpdate(
      { identifier },
      { $setOnInsert: { identifier } },
      { upsert: true, new: true },
    );
    if (user === null) {
      throw new Error("User upsert returned null");
    }
    return String(user._id);
  },

  async insertConfirmedOrder(doc): Promise<string> {
    const order = await Order.create({ ...doc, status: "confirmed" });
    return String(order._id);
  },

  async insertOrderLine(doc): Promise<void> {
    await OrderLine.create(doc);
  },
};

/** Mongo duplicate-key error (the (saleId, email) unique index tripping). */
function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000;
}

export function createOrderRecorder(
  productId: string,
  flashSalePrice: number,
  ops: AuditModelOps = mongoAuditModelOps,
): OrderAuditPort {
  return {
    async recordOrder(saleId: string, email: string): Promise<void> {
      const userId = await ops.upsertUser(email);
      let orderId: string;
      try {
        orderId = await ops.insertConfirmedOrder({ saleId, email, userId });
      } catch (err) {
        if (isDuplicateKey(err)) {
          // Defense-in-depth index doing its job: this order is already
          // recorded (Redis guarantees one OK per email while serving; a
          // duplicate can only arise from anomalies such as operator replay).
          return;
        }
        throw err;
      }
      // Snapshot the flash-sale price at the moment of acceptance — the
      // server-sourced price, never a value from the client request.
      await ops.insertOrderLine({
        orderId,
        productId,
        quantity: 1,
        unitPrice: flashSalePrice,
      });
    },
  };
}
