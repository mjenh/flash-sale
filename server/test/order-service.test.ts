// Unit tests for the order service (AC 1, 2, 3, 4) — injected clock + fake
// port, zero I/O. Proves the AD-2 precedence and the AD-6 [start, end)
// boundaries: outside the window ONE SISMEMBER decides already-vs-inactive
// and the script never runs; inside it the script decides everything.
import { describe, expect, it, vi } from "vitest";
import { createOrderService, type OrderAttemptPort } from "../src/services/order.ts";

const startMs = Date.parse("2026-07-10T04:00:00Z");
const endMs = Date.parse("2026-07-10T05:00:00Z");
const window = {
  startMs,
  endMs,
  startIso: "2026-07-10T04:00:00.000Z",
  endIso: "2026-07-10T05:00:00.000Z",
};

function build(nowMs: number, port: Partial<OrderAttemptPort> = {}) {
  const orders = {
    attempt: vi.fn(async () => ({ verdict: "OK" as const, remaining: 99 })),
    hasOrdered: vi.fn(async () => false),
    ...port,
  };
  return { orders, service: createOrderService({ clock: () => nowMs, window, orders }) };
}

describe("order service — AD-2 precedence on the injected clock", () => {
  describe("outside the window the script never runs", () => {
    const instants: Array<[string, number]> = [
      ["before start", startMs - 1],
      ["exactly endMs (boundary — outside, [start, end))", endMs],
      ["after end", endMs + 60_000],
    ];

    for (const [label, now] of instants) {
      it(`${label}, no prior order -> inactive via one SISMEMBER`, async () => {
        const { orders, service } = build(now);
        expect(await service.attempt("new@x.com")).toEqual({ outcome: "inactive" });
        expect(orders.hasOrdered).toHaveBeenCalledExactlyOnceWith("new@x.com");
        expect(orders.attempt).not.toHaveBeenCalled();
      });

      it(`${label}, prior order -> already (order holder always wins)`, async () => {
        const { orders, service } = build(now, { hasOrdered: vi.fn(async () => true) });
        expect(await service.attempt("held@x.com")).toEqual({ outcome: "already" });
        expect(orders.attempt).not.toHaveBeenCalled();
      });
    }
  });

  describe("inside the window the AD-1 script decides", () => {
    it("exactly startMs (boundary — inside) runs the script, no SISMEMBER probe", async () => {
      const { orders, service } = build(startMs);
      expect(await service.attempt("a@x.com")).toEqual({ outcome: "created", remaining: 99 });
      expect(orders.attempt).toHaveBeenCalledExactlyOnceWith("a@x.com");
      expect(orders.hasOrdered).not.toHaveBeenCalled();
    });

    it("maps OK -> created with remaining passed through", async () => {
      const { service } = build(startMs + 1000, {
        attempt: vi.fn(async () => ({ verdict: "OK" as const, remaining: 0 })),
      });
      expect(await service.attempt("last@x.com")).toEqual({ outcome: "created", remaining: 0 });
    });

    it("maps ALREADY -> already", async () => {
      const { service } = build(startMs + 1000, {
        attempt: vi.fn(async () => ({ verdict: "ALREADY" as const, remaining: 42 })),
      });
      expect(await service.attempt("dup@x.com")).toEqual({ outcome: "already", remaining: 42 });
    });

    it("maps SOLD_OUT -> sold_out", async () => {
      const { service } = build(startMs + 1000, {
        attempt: vi.fn(async () => ({ verdict: "SOLD_OUT" as const, remaining: 0 })),
      });
      expect(await service.attempt("late@x.com")).toEqual({ outcome: "sold_out", remaining: 0 });
    });
  });

  it("port rejections propagate untouched (the 503 signal is the adapter's)", async () => {
    const boom = new Error("redis gone");
    const { service } = build(startMs + 1, {
      attempt: vi.fn(async () => {
        throw boom;
      }),
    });
    await expect(service.attempt("a@x.com")).rejects.toBe(boom);
  });
});
