// Unit tests: the order recorder composition (AC 1, 2) — fake model ops,
// zero I/O. Proves the accept-path write ordering (upsert User -> insert
// Order -> insert OrderLine), the exact audit fields, and the duplicate-key
// (E11000) benign no-op — the (saleId, email) defense-in-depth index.
import { describe, expect, it, vi } from "vitest";
import { createOrderRecorder, type AuditModelOps } from "../src/adapters/mongo/audit.ts";

const refs = { saleId: "sale-1", productId: "product-1" };

function fakeOps() {
  return {
    upsertUser: vi.fn<AuditModelOps["upsertUser"]>(async () => "user-9"),
    insertConfirmedOrder: vi.fn<AuditModelOps["insertConfirmedOrder"]>(async () => "order-7"),
    insertOrderLine: vi.fn<AuditModelOps["insertOrderLine"]>(async () => {}),
  };
}

describe("createOrderRecorder (AD-3 accept-path writes)", () => {
  it("writes upsert User -> insert Order -> insert OrderLine, threading ids", async () => {
    const ops = fakeOps();
    await createOrderRecorder(refs, ops).recordOrder("buyer@example.com");

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
      unitPrice: 0,
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
    await expect(createOrderRecorder(refs, ops).recordOrder("dup@example.com")).resolves.toBeUndefined();
    expect(ops.insertOrderLine).not.toHaveBeenCalled();
  });

  it("a non-duplicate order-insert failure propagates (the service logs it — AC 2)", async () => {
    const boom = new Error("mongo down");
    const ops = fakeOps();
    ops.insertConfirmedOrder.mockRejectedValue(boom);
    await expect(createOrderRecorder(refs, ops).recordOrder("x@example.com")).rejects.toBe(boom);
  });

  it("an upsertUser failure propagates and no Order is inserted", async () => {
    const boom = new Error("mongo down");
    const ops = fakeOps();
    ops.upsertUser.mockRejectedValue(boom);
    await expect(createOrderRecorder(refs, ops).recordOrder("x@example.com")).rejects.toBe(boom);
    expect(ops.insertConfirmedOrder).not.toHaveBeenCalled();
    expect(ops.insertOrderLine).not.toHaveBeenCalled();
  });

  it("an orderLine failure propagates (order already recorded — logged, never rolled back)", async () => {
    const boom = new Error("mongo down");
    const ops = fakeOps();
    ops.insertOrderLine.mockRejectedValue(boom);
    await expect(createOrderRecorder(refs, ops).recordOrder("x@example.com")).rejects.toBe(boom);
    expect(ops.insertConfirmedOrder).toHaveBeenCalledTimes(1);
  });
});
