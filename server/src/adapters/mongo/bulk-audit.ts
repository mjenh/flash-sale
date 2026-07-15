// Write-Behind MongoDB persistence layer — called by the background worker,
// never on the HTTP request path.
//
// Idempotency per collection (safe under retry / at-least-once delivery):
//   Users:      unique index on `identifier` — $setOnInsert is a no-op on re-run.
//   Orders:     unique index on (saleId, email) — $setOnInsert is a no-op on re-run.
//   OrderLines: filter on (orderId, productId) + $setOnInsert — safe for single-consumer.
//     (`orderId` here is the Mongo Order._id, resolved in Phase 4; the UUID
//      in QueueOrderPayload.orderId is a queue correlation ID, not the Mongo PK.)
//
// All three bulkWrites use ordered: false so one duplicate-key skip does not
// abort the rest of the batch.
import { Types } from "mongoose";
import { User, Order, OrderLine } from "./models.ts";
import type { QueueOrderPayload } from "../redis/order-queue.ts";

export interface BulkAuditPort {
  /** Persist a batch of accepted orders to MongoDB idempotently. */
  bulkRecordOrders(payloads: QueueOrderPayload[]): Promise<void>;
}

export const mongoBulkAudit: BulkAuditPort = {
  async bulkRecordOrders(payloads: QueueOrderPayload[]): Promise<void> {
    if (payloads.length === 0) {
      return;
    }

    // Phase 1: bulk upsert Users by email (the `identifier` field).
    await User.bulkWrite(
      payloads.map((p) => ({
        updateOne: {
          filter: { identifier: p.email },
          update: { $setOnInsert: { identifier: p.email } },
          upsert: true,
        },
      })),
      { ordered: false },
    );

    // Phase 2: resolve User _ids — needed as FK on Order.userId.
    const uniqueEmails = [...new Set(payloads.map((p) => p.email))];
    const userDocs = await User.find({ identifier: { $in: uniqueEmails } })
      .select("_id identifier")
      .lean();
    const userIdByEmail = new Map<string, string>(
      userDocs.map((u) => [u.identifier, String(u._id)]),
    );

    // Phase 3: bulk upsert Orders. (saleId, email) unique index prevents
    // duplicate audit records; $setOnInsert is a no-op when the row exists.
    // saleId and userId are ObjectId in the schema — cast from string payload.
    await Order.bulkWrite(
      payloads.map((p) => {
        const saleObjId = new Types.ObjectId(p.saleId);
        const userIdStr = userIdByEmail.get(p.email);
        const userObjId = userIdStr !== undefined ? new Types.ObjectId(userIdStr) : undefined;
        return {
          updateOne: {
            filter: { saleId: saleObjId, email: p.email },
            update: {
              $setOnInsert: {
                saleId: saleObjId,
                email: p.email,
                userId: userObjId,
                status: "confirmed" as const,
              },
            },
            upsert: true,
          },
        };
      }),
      { ordered: false },
    );

    // Phase 4: resolve Order _ids — needed as FK on OrderLine.orderId.
    const orderDocs = await Order.find({
      $or: payloads.map((p) => ({ saleId: new Types.ObjectId(p.saleId), email: p.email })),
    })
      .select("_id email")
      .lean();
    const orderIdByEmail = new Map<string, Types.ObjectId>(
      orderDocs.map((o) => [o.email, o._id]),
    );

    // Phase 5: bulk upsert OrderLines, idempotent on (orderId, productId).
    // Filter out any payload whose Order wasn't found (defensive — should never
    // happen since Phase 3 upserted them, but better than a bad FK insert).
    const lineOps = payloads
      .map((p) => {
        const orderId = orderIdByEmail.get(p.email);
        if (orderId === undefined) {
          return null;
        }
        // Mongoose schema types productId as ObjectId; cast the string from the
        // queue payload so TypeScript's bulkWrite overload resolves correctly.
        const productObjId = new Types.ObjectId(p.productId);
        return {
          updateOne: {
            filter: { orderId, productId: productObjId },
            update: {
              $setOnInsert: {
                orderId,
                productId: productObjId,
                quantity: 1,
                unitPrice: 0,
              },
            },
            upsert: true,
          },
        };
      })
      .filter((op): op is NonNullable<typeof op> => op !== null);

    if (lineOps.length > 0) {
      await OrderLine.bulkWrite(lineOps, { ordered: false });
    }
  },
};
