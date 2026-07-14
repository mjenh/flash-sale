// Injected clock + fake StockReader, zero I/O. Boundary instants are
// load-bearing: now === start is INSIDE the [start, end) window;
// now === end is OUTSIDE (ended).
//
// Story 4.4: getStatus(saleId, window) takes both as per-call arguments
// instead of a window frozen at construction — SALE_ID/window below are
// passed to every getStatus() call, proving the service is saleId-agnostic
// at construction time (StockReader.getRemaining is asserted against the
// exact saleId it was called with).
import { describe, expect, it } from "vitest";
import { createSaleStatusService, type StockReader } from "../src/services/sale-status.ts";

const SALE_ID = "sale-1";
const startMs = Date.parse("2026-07-10T04:00:00Z");
const endMs = Date.parse("2026-07-10T05:00:00Z");
const window = {
  startMs,
  endMs,
  startIso: "2026-07-10T04:00:00.000Z",
  endIso: "2026-07-10T05:00:00.000Z",
};

function service(nowMs: number, stockValue: number | Error) {
  const stock: StockReader = {
    getRemaining: async (saleId: string) => {
      expect(saleId).toBe(SALE_ID);
      if (stockValue instanceof Error) {
        throw stockValue;
      }
      return stockValue;
    },
  };
  return createSaleStatusService({ clock: () => nowMs, stock });
}

describe("createSaleStatusService", () => {
  it("reports upcoming before the window, with stock and ISO times in the body", async () => {
    const body = await service(startMs - 1, 100).getStatus(SALE_ID, window);
    expect(body).toEqual({
      success: true,
      status: "upcoming",
      stock: 100,
      startTime: "2026-07-10T04:00:00.000Z",
      endTime: "2026-07-10T05:00:00.000Z",
    });
  });

  it("reports active inside the window while stock > 0", async () => {
    const body = await service(startMs + 1000, 5).getStatus(SALE_ID, window);
    expect(body.status).toBe("active");
    expect(body.stock).toBe(5);
  });

  it("reports sold_out inside the window at stock 0", async () => {
    const body = await service(startMs + 1000, 0).getStatus(SALE_ID, window);
    expect(body.status).toBe("sold_out");
    expect(body.stock).toBe(0);
  });

  it("reports ended at or after the window end", async () => {
    const body = await service(endMs + 1, 100).getStatus(SALE_ID, window);
    expect(body.status).toBe("ended");
  });

  it("boundary: exactly start is inside the window — active with stock", async () => {
    const body = await service(startMs, 3).getStatus(SALE_ID, window);
    expect(body.status).toBe("active");
  });

  it("boundary: exactly start with stock 0 is sold_out, not upcoming", async () => {
    const body = await service(startMs, 0).getStatus(SALE_ID, window);
    expect(body.status).toBe("sold_out");
  });

  it("boundary: exactly end is ended, even with stock remaining ([start, end))", async () => {
    const body = await service(endMs, 50).getStatus(SALE_ID, window);
    expect(body.status).toBe("ended");
  });

  it("propagates stock reader failures unchanged (fail-closed path)", async () => {
    const boom = new Error("redis gone");
    await expect(service(startMs, boom).getStatus(SALE_ID, window)).rejects.toBe(boom);
  });
});
