// Fake model ops, zero I/O. Proves the accept-path write ordering
// (upsert User -> insert Order -> insert OrderLine), the exact audit
// fields, and the duplicate-key (E11000) benign no-op.
//
// recordOrder(saleId, email) takes saleId per call — the recorder only
// closes over productId.
import { describe, expect, it, vi } from "vitest";
import { type AuditModelOps, createOrderRecorder } from "../src/adapters/mongo/audit.ts";

const SALE_ID = "sale-1";
const PRODUCT_ID = "product-1";
const FLASH_SALE_PRICE = 99.99;

function fakeOps() {
  return {
    upsertUser: vi.fn<AuditModelOps["upsertUser"]>(async () => "user-9"),
    insertConfirmedOrder: vi.fn<AuditModelOps["insertConfirmedOrder"]>(async () => "order-7"),
    insertOrderLine: vi.fn<AuditModelOps["insertOrderLine"]>(async () => {}),
  };
}

describe("createOrderRecorder (accept-path writes)", () => {
  it("writes upsert User -> insert Order -> insert OrderLine, threading ids and snapshotting price", async () => {
    const ops = fakeOps();
    await createOrderRecorder(PRODUCT_ID, FLASH_SALE_PRICE, ops).recordOrder(SALE_ID, "buyer@example.com");

    expect(ops.upsertUser).toHaveBeenCalledExactlyOnceWith("buyer@example.com");
    expect(ops.insertConfirmedOrder).toHaveBeenCalledExactlyOnceWith({
      saleId: "sale-1",
      email: "buyer@example.com",
      userId: "user-9",
    });
    expect(ops.insertOrderLine).toHaveBeenCalledExactlyOnceWith({
      orderId: "order-7",
      productId: "product-1",
      quantity: 1,
      unitPrice: FLASH_SALE_PRICE,
    });

    const [userCall] = ops.upsertUser.mock.invocationCallOrder;
    const [orderCall] = ops.insertConfirmedOrder.mock.invocationCallOrder;
    const [lineCall] = ops.insertOrderLine.mock.invocationCallOrder;
    expect(userCall).toBeLessThan(orderCall as number);
    expect(orderCall).toBeLessThan(lineCall as number);
  });

  it("a duplicate-key rejection (code 11000) resolves as a benign no-op — no OrderLine", async () => {
    const ops = fakeOps();
    ops.insertConfirmedOrder.mockRejectedValue(
      Object.assign(new Error("E11000 duplicate key error"), { code: 11000 }),
    );
    await expect(
      createOrderRecorder(PRODUCT_ID, FLASH_SALE_PRICE, ops).recordOrder(SALE_ID, "dup@example.com"),
    ).resolves.toBeUndefined();
    expect(ops.insertOrderLine).not.toHaveBeenCalled();
  });

  it("a non-duplicate order-insert failure propagates", async () => {
    const boom = new Error("mongo down");
    const ops = fakeOps();
    ops.insertConfirmedOrder.mockRejectedValue(boom);
    await expect(createOrderRecorder(PRODUCT_ID, FLASH_SALE_PRICE, ops).recordOrder(SALE_ID, "x@example.com")).rejects.toBe(boom);
  });

  it("an upsertUser failure propagates and no Order is inserted", async () => {
    const boom = new Error("mongo down");
    const ops = fakeOps();
    ops.upsertUser.mockRejectedValue(boom);
    await expect(createOrderRecorder(PRODUCT_ID, FLASH_SALE_PRICE, ops).recordOrder(SALE_ID, "x@example.com")).rejects.toBe(boom);
    expect(ops.insertConfirmedOrder).not.toHaveBeenCalled();
    expect(ops.insertOrderLine).not.toHaveBeenCalled();
  });

  it("an orderLine failure propagates (order already recorded — logged, never rolled back)", async () => {
    const boom = new Error("mongo down");
    const ops = fakeOps();
    ops.insertOrderLine.mockRejectedValue(boom);
    await expect(createOrderRecorder(PRODUCT_ID, FLASH_SALE_PRICE, ops).recordOrder(SALE_ID, "x@example.com")).rejects.toBe(boom);
    expect(ops.insertConfirmedOrder).toHaveBeenCalledTimes(1);
  });
});
