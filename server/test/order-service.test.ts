// Unit tests for the order service (Story 1.3 AC 1-4 + Story 1.4 AC 1-2 +
// Story 1.5 AC 1/2/4) — injected clock + fake ports, zero I/O. Proves the
// AD-2 precedence, the AD-6 [start, end) boundaries, the Story-1.4
// post-accept side effects (audit + payment fire-and-forget after OK only,
// failures reported, outcome never altered or delayed — AD-3/AD-10), and the
// Story-1.5 hasOrdered read (pure delegation: no clock, no script, no side
// effects).
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

/** Drain the microtask/immediate queue so fire-and-forget effects settle. */
const drain = () => new Promise((resolve) => setImmediate(resolve));

function build(
  nowMs: number,
  opts: {
    port?: Partial<OrderAttemptPort>;
    recordOrder?: (email: string) => Promise<void>;
    charge?: (email: string) => Promise<{ approved: boolean; reference: string }>;
  } = {},
) {
  const orders = {
    attempt: vi.fn(async () => ({ verdict: "OK" as const, remaining: 99 })),
    hasOrdered: vi.fn(async () => false),
    ...opts.port,
  };
  const audit = { recordOrder: vi.fn(opts.recordOrder ?? (async () => {})) };
  const payment = {
    charge: vi.fn(
      opts.charge ?? (async (email: string) => ({ approved: true, reference: `noop:${email}` })),
    ),
  };
  const report = vi.fn();
  return {
    orders,
    audit,
    payment,
    report,
    service: createOrderService({
      clock: () => nowMs,
      window,
      orders,
      audit,
      payment,
      reportSideEffectFailure: report,
    }),
  };
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
        const { orders, service } = build(now, { port: { hasOrdered: vi.fn(async () => true) } });
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
        port: { attempt: vi.fn(async () => ({ verdict: "OK" as const, remaining: 0 })) },
      });
      expect(await service.attempt("last@x.com")).toEqual({ outcome: "created", remaining: 0 });
    });

    it("maps ALREADY -> already", async () => {
      const { service } = build(startMs + 1000, {
        port: { attempt: vi.fn(async () => ({ verdict: "ALREADY" as const, remaining: 42 })) },
      });
      expect(await service.attempt("dup@x.com")).toEqual({ outcome: "already", remaining: 42 });
    });

    it("maps SOLD_OUT -> sold_out", async () => {
      const { service } = build(startMs + 1000, {
        port: { attempt: vi.fn(async () => ({ verdict: "SOLD_OUT" as const, remaining: 0 })) },
      });
      expect(await service.attempt("late@x.com")).toEqual({ outcome: "sold_out", remaining: 0 });
    });
  });

  it("port rejections propagate untouched (the 503 signal is the adapter's)", async () => {
    const boom = new Error("redis gone");
    const { service } = build(startMs + 1, {
      port: {
        attempt: vi.fn(async () => {
          throw boom;
        }),
      },
    });
    await expect(service.attempt("a@x.com")).rejects.toBe(boom);
  });
});

describe("order service — Story 1.4 post-accept side effects (AD-3/AD-10)", () => {
  it("OK -> audit.recordOrder and payment.charge each fire once with the email", async () => {
    const { audit, payment, report, service } = build(startMs + 1000);
    await service.attempt("winner@x.com");
    await drain();
    expect(audit.recordOrder).toHaveBeenCalledExactlyOnceWith("winner@x.com");
    expect(payment.charge).toHaveBeenCalledExactlyOnceWith("winner@x.com");
    expect(report).not.toHaveBeenCalled();
  });

  it("an audit rejection is reported, never thrown — outcome stays created (AC 2)", async () => {
    const boom = new Error("mongo down");
    const { report, service } = build(startMs + 1000, {
      recordOrder: vi.fn(async () => {
        throw boom;
      }),
    });
    expect(await service.attempt("winner@x.com")).toEqual({ outcome: "created", remaining: 99 });
    await drain();
    expect(report).toHaveBeenCalledExactlyOnceWith("audit", boom);
  });

  it("a payment rejection is reported, never thrown — outcome stays created", async () => {
    const boom = new Error("gateway down");
    const { report, service } = build(startMs + 1000, {
      charge: vi.fn(async () => {
        throw boom;
      }),
    });
    expect(await service.attempt("winner@x.com")).toEqual({ outcome: "created", remaining: 99 });
    await drain();
    expect(report).toHaveBeenCalledExactlyOnceWith("payment", boom);
  });

  it("a declined payment is reported — outcome stays created (AD-10: cannot fail an order)", async () => {
    const { report, service } = build(startMs + 1000, {
      charge: vi.fn(async () => ({ approved: false, reference: "declined:x" })),
    });
    expect(await service.attempt("winner@x.com")).toEqual({ outcome: "created", remaining: 99 });
    await drain();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBe("payment");
  });

  it("a never-settling audit write does not delay the verdict (fire-and-forget, AD-8)", async () => {
    const { service } = build(startMs + 1000, {
      recordOrder: vi.fn(() => new Promise<void>(() => {})),
    });
    // If the service awaited the audit promise this would time out.
    expect(await service.attempt("winner@x.com")).toEqual({ outcome: "created", remaining: 99 });
  });

  it("ALREADY and SOLD_OUT verdicts never touch audit or payment (negative space)", async () => {
    for (const verdict of ["ALREADY", "SOLD_OUT"] as const) {
      const { audit, payment, service } = build(startMs + 1000, {
        port: { attempt: vi.fn(async () => ({ verdict, remaining: 0 })) },
      });
      await service.attempt("x@x.com");
      await drain();
      expect(audit.recordOrder).not.toHaveBeenCalled();
      expect(payment.charge).not.toHaveBeenCalled();
    }
  });

  it("outside-window paths (inactive AND already) never touch audit or payment", async () => {
    for (const hasOrdered of [false, true]) {
      const { audit, payment, service } = build(endMs + 1, {
        port: { hasOrdered: vi.fn(async () => hasOrdered) },
      });
      await service.attempt("x@x.com");
      await drain();
      expect(audit.recordOrder).not.toHaveBeenCalled();
      expect(payment.charge).not.toHaveBeenCalled();
    }
  });
});

describe("order service — Story 1.5 hasOrdered (FR-4 read)", () => {
  /** hasOrdered must be clock-free (AD-2/AD-8) — a throwing clock proves it. */
  function buildReadOnly(hasOrderedResult: () => Promise<boolean>) {
    const clock = vi.fn(() => {
      throw new Error("hasOrdered must never consult the clock");
    });
    const orders = {
      attempt: vi.fn(async () => ({ verdict: "OK" as const, remaining: 99 })),
      hasOrdered: vi.fn(hasOrderedResult),
    };
    const audit = { recordOrder: vi.fn(async () => {}) };
    const payment = {
      charge: vi.fn(async (email: string) => ({ approved: true, reference: `noop:${email}` })),
    };
    return {
      clock,
      orders,
      audit,
      payment,
      service: createOrderService({
        clock,
        window,
        orders,
        audit,
        payment,
        reportSideEffectFailure: vi.fn(),
      }),
    };
  }

  it("passes true through with the exact email — clock never read", async () => {
    const { clock, orders, service } = buildReadOnly(async () => true);
    expect(await service.hasOrdered("held@x.com")).toBe(true);
    expect(orders.hasOrdered).toHaveBeenCalledExactlyOnceWith("held@x.com");
    expect(clock).not.toHaveBeenCalled();
  });

  it("passes false through with the exact email", async () => {
    const { orders, service } = buildReadOnly(async () => false);
    expect(await service.hasOrdered("new@x.com")).toBe(false);
    expect(orders.hasOrdered).toHaveBeenCalledExactlyOnceWith("new@x.com");
  });

  it("port rejections propagate untouched (the 503 signal is the adapter's)", async () => {
    const boom = new Error("redis gone");
    const { service } = buildReadOnly(async () => {
      throw boom;
    });
    await expect(service.hasOrdered("x@x.com")).rejects.toBe(boom);
  });

  it("is a pure read: never runs the script, never audits, never charges", async () => {
    const { orders, audit, payment, service } = buildReadOnly(async () => true);
    await service.hasOrdered("held@x.com");
    await drain();
    expect(orders.attempt).not.toHaveBeenCalled();
    expect(audit.recordOrder).not.toHaveBeenCalled();
    expect(payment.charge).not.toHaveBeenCalled();
  });
});
