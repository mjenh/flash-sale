// Injected clock + fake ports, zero I/O. Proves the precedence, the
// [start, end) boundaries, the post-accept side effects (audit + payment
// fire-and-forget after OK only, failures reported, outcome never altered or
// delayed), the hasOrdered read (pure delegation: no clock, no script, no
// side effects), and the publishes (order.accepted on every OK;
// sale.sold_out exactly once, by the draining request; SOLD_OUT verdicts
// never publish; publish failures never alter the outcome).
//
// Story 4.4: attempt() takes a SaleContext ({ saleId, window }) as its first
// argument instead of window living in the service's deps — SALE_ID/ctx
// below are threaded through every attempt() call, and the saleId-
// parameterized ports (orders.attempt/hasOrdered, audit.recordOrder,
// events.publish) are asserted against the exact saleId passed through.
import { describe, expect, it, vi } from "vitest";
import { createOrderService, type OrderAttemptPort, type SaleContext } from "../src/services/order.ts";
import { START_MS, END_MS, WINDOW } from "./helpers/time-fixtures.ts";

const SALE_ID = "sale-1";
const startMs = START_MS;
const endMs = END_MS;
const window = WINDOW;
const ctx: SaleContext = { saleId: SALE_ID, window };

/** Drain the microtask/immediate queue so fire-and-forget effects settle. */
const drain = () => new Promise((resolve) => setImmediate(resolve));

function build(
  nowMs: number,
  opts: {
    port?: Partial<OrderAttemptPort>;
    recordOrder?: (saleId: string, email: string) => Promise<void>;
    charge?: (email: string) => Promise<{ approved: boolean; reference: string }>;
    publish?: (event: "order.accepted" | "sale.sold_out", saleId: string) => Promise<void>;
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
  const events = { publish: vi.fn(opts.publish ?? (async () => {})) };
  const report = vi.fn();
  return {
    orders,
    audit,
    payment,
    events,
    report,
    service: createOrderService({
      clock: () => nowMs,
      orders,
      audit,
      payment,
      events,
      reportSideEffectFailure: report,
    }),
  };
}

describe("order service — precedence on the injected clock", () => {
  describe("outside the window the script never runs", () => {
    const instants: Array<[string, number]> = [
      ["before start", startMs - 1],
      ["exactly endMs (boundary — outside, [start, end))", endMs],
      ["after end", endMs + 60_000],
    ];

    for (const [label, now] of instants) {
      it(`${label}, no prior order -> inactive via one SISMEMBER`, async () => {
        const { orders, service } = build(now);
        expect(await service.attempt(ctx, "new@x.com")).toEqual({ outcome: "inactive" });
        expect(orders.hasOrdered).toHaveBeenCalledExactlyOnceWith(SALE_ID, "new@x.com");
        expect(orders.attempt).not.toHaveBeenCalled();
      });

      it(`${label}, prior order -> already (order holder always wins)`, async () => {
        const { orders, service } = build(now, { port: { hasOrdered: vi.fn(async () => true) } });
        expect(await service.attempt(ctx, "held@x.com")).toEqual({ outcome: "already" });
        expect(orders.attempt).not.toHaveBeenCalled();
      });
    }
  });

  describe("inside the window the script decides", () => {
    it("exactly startMs (boundary — inside) runs the script, no SISMEMBER probe", async () => {
      const { orders, service } = build(startMs);
      expect(await service.attempt(ctx, "a@x.com")).toEqual({ outcome: "created", remaining: 99 });
      expect(orders.attempt).toHaveBeenCalledExactlyOnceWith(SALE_ID, "a@x.com");
      expect(orders.hasOrdered).not.toHaveBeenCalled();
    });

    it("maps OK -> created with remaining passed through", async () => {
      const { service } = build(startMs + 1000, {
        port: { attempt: vi.fn(async () => ({ verdict: "OK" as const, remaining: 0 })) },
      });
      expect(await service.attempt(ctx, "last@x.com")).toEqual({ outcome: "created", remaining: 0 });
    });

    it("maps ALREADY -> already", async () => {
      const { service } = build(startMs + 1000, {
        port: { attempt: vi.fn(async () => ({ verdict: "ALREADY" as const, remaining: 42 })) },
      });
      expect(await service.attempt(ctx, "dup@x.com")).toEqual({ outcome: "already", remaining: 42 });
    });

    it("maps SOLD_OUT -> sold_out", async () => {
      const { service } = build(startMs + 1000, {
        port: { attempt: vi.fn(async () => ({ verdict: "SOLD_OUT" as const, remaining: 0 })) },
      });
      expect(await service.attempt(ctx, "late@x.com")).toEqual({ outcome: "sold_out", remaining: 0 });
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
    await expect(service.attempt(ctx, "a@x.com")).rejects.toBe(boom);
  });
});

describe("order service — post-accept side effects", () => {
  it("OK -> audit.recordOrder and payment.charge each fire once with the saleId + email", async () => {
    const { audit, payment, report, service } = build(startMs + 1000);
    await service.attempt(ctx, "winner@x.com");
    await drain();
    expect(audit.recordOrder).toHaveBeenCalledExactlyOnceWith(SALE_ID, "winner@x.com");
    expect(payment.charge).toHaveBeenCalledExactlyOnceWith("winner@x.com");
    expect(report).not.toHaveBeenCalled();
  });

  it("an audit rejection is reported, never thrown — outcome stays created", async () => {
    const boom = new Error("mongo down");
    const { report, service } = build(startMs + 1000, {
      recordOrder: vi.fn(async () => {
        throw boom;
      }),
    });
    expect(await service.attempt(ctx, "winner@x.com")).toEqual({ outcome: "created", remaining: 99 });
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
    expect(await service.attempt(ctx, "winner@x.com")).toEqual({ outcome: "created", remaining: 99 });
    await drain();
    expect(report).toHaveBeenCalledExactlyOnceWith("payment", boom);
  });

  it("a declined payment is reported — outcome stays created (cannot fail an order)", async () => {
    const { report, service } = build(startMs + 1000, {
      charge: vi.fn(async () => ({ approved: false, reference: "declined:x" })),
    });
    expect(await service.attempt(ctx, "winner@x.com")).toEqual({ outcome: "created", remaining: 99 });
    await drain();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBe("payment");
  });

  it("a never-settling audit write does not delay the verdict (fire-and-forget)", async () => {
    const { service } = build(startMs + 1000, {
      recordOrder: vi.fn(() => new Promise<void>(() => {})),
    });
    // If the service awaited the audit promise this would time out.
    expect(await service.attempt(ctx, "winner@x.com")).toEqual({ outcome: "created", remaining: 99 });
  });

  it("ALREADY and SOLD_OUT verdicts never touch audit or payment (negative space)", async () => {
    for (const verdict of ["ALREADY", "SOLD_OUT"] as const) {
      const { audit, payment, service } = build(startMs + 1000, {
        port: { attempt: vi.fn(async () => ({ verdict, remaining: 0 })) },
      });
      await service.attempt(ctx, "x@x.com");
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
      await service.attempt(ctx, "x@x.com");
      await drain();
      expect(audit.recordOrder).not.toHaveBeenCalled();
      expect(payment.charge).not.toHaveBeenCalled();
    }
  });
});

describe("order service — publishes on accept", () => {
  it("OK with remaining > 0 -> exactly one publish('order.accepted', saleId), zero sale.sold_out", async () => {
    const { events, report, service } = build(startMs + 1000);
    expect(await service.attempt(ctx, "winner@x.com")).toEqual({ outcome: "created", remaining: 99 });
    await drain();
    expect(events.publish).toHaveBeenCalledExactlyOnceWith("order.accepted", SALE_ID);
    expect(report).not.toHaveBeenCalled();
  });

  it("OK with remaining === 0 -> both published; sale.sold_out exactly once, by the draining request", async () => {
    const { events, service } = build(startMs + 1000, {
      port: { attempt: vi.fn(async () => ({ verdict: "OK" as const, remaining: 0 })) },
    });
    expect(await service.attempt(ctx, "last@x.com")).toEqual({ outcome: "created", remaining: 0 });
    await drain();
    expect(events.publish.mock.calls).toEqual([
      ["order.accepted", SALE_ID],
      ["sale.sold_out", SALE_ID],
    ]);
  });

  it("Scenario D: stock exactly 1 → first buyer succeeds AND triggers sale.sold_out (remaining === 0)", async () => {
    // The draining request is the most critical happy-path edge case: the
    // single unit remaining is claimed, remaining drops to 0, and the
    // sold_out event fires exactly once — no more, no less.
    const { events, service } = build(startMs + 1000, {
      port: { attempt: vi.fn(async () => ({ verdict: "OK" as const, remaining: 0 })) },
    });

    const result = await service.attempt(ctx, "last-buyer@x.com");
    await drain();

    expect(result).toEqual({ outcome: "created", remaining: 0 });
    expect(events.publish.mock.calls).toEqual([
      ["order.accepted", SALE_ID],
      ["sale.sold_out", SALE_ID],
    ]);
  });

  it("a SECOND attempt after the draining one (ALREADY verdict) publishes nothing more", async () => {
    const attempt = vi
      .fn()
      .mockResolvedValueOnce({ verdict: "OK" as const, remaining: 0 })
      .mockResolvedValueOnce({ verdict: "ALREADY" as const, remaining: 0 });
    const { events, service } = build(startMs + 1000, { port: { attempt } });
    await service.attempt(ctx, "last@x.com");
    await service.attempt(ctx, "last@x.com");
    await drain();
    expect(events.publish.mock.calls).toEqual([
      ["order.accepted", SALE_ID],
      ["sale.sold_out", SALE_ID],
    ]);
  });

  it("SOLD_OUT verdicts NEVER publish — not even sale.sold_out (negative space)", async () => {
    const { events, service } = build(startMs + 1000, {
      port: { attempt: vi.fn(async () => ({ verdict: "SOLD_OUT" as const, remaining: 0 })) },
    });
    expect(await service.attempt(ctx, "late@x.com")).toEqual({ outcome: "sold_out", remaining: 0 });
    await drain();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it("outside-window paths (inactive AND already) publish zero events", async () => {
    for (const hasOrdered of [false, true]) {
      const { events, service } = build(endMs + 1, {
        port: { hasOrdered: vi.fn(async () => hasOrdered) },
      });
      await service.attempt(ctx, "x@x.com");
      await drain();
      expect(events.publish).not.toHaveBeenCalled();
    }
  });

  it("a publish rejection is reported as 'publish', never thrown — outcome stays exactly created", async () => {
    const boom = new Error("redis publish gone");
    const { report, service } = build(startMs + 1000, {
      publish: vi.fn(async () => {
        throw boom;
      }),
    });
    expect(await service.attempt(ctx, "winner@x.com")).toEqual({ outcome: "created", remaining: 99 });
    await drain();
    expect(report).toHaveBeenCalledExactlyOnceWith("publish", boom);
  });

  it("both publishes rejecting on the draining request -> two 'publish' reports, outcome still created", async () => {
    const boom = new Error("redis publish gone");
    const { report, service } = build(startMs + 1000, {
      port: { attempt: vi.fn(async () => ({ verdict: "OK" as const, remaining: 0 })) },
      publish: vi.fn(async () => {
        throw boom;
      }),
    });
    expect(await service.attempt(ctx, "last@x.com")).toEqual({ outcome: "created", remaining: 0 });
    await drain();
    expect(report.mock.calls).toEqual([
      ["publish", boom],
      ["publish", boom],
    ]);
  });

  it("a never-settling publish does not delay the outcome (fire-and-forget)", async () => {
    const { service } = build(startMs + 1000, {
      publish: vi.fn(() => new Promise<void>(() => {})),
    });
    // If the service awaited the publish promise this would time out.
    expect(await service.attempt(ctx, "winner@x.com")).toEqual({ outcome: "created", remaining: 99 });
  });
});

describe("order service — hasOrdered", () => {
  /** hasOrdered must be clock-free — a throwing clock proves it. */
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
    const events = { publish: vi.fn(async () => {}) };
    return {
      clock,
      orders,
      audit,
      payment,
      events,
      service: createOrderService({
        clock,
        orders,
        audit,
        payment,
        events,
        reportSideEffectFailure: vi.fn(),
      }),
    };
  }

  it("passes true through with the exact saleId + email — clock never read", async () => {
    const { clock, orders, service } = buildReadOnly(async () => true);
    expect(await service.hasOrdered(SALE_ID, "held@x.com")).toBe(true);
    expect(orders.hasOrdered).toHaveBeenCalledExactlyOnceWith(SALE_ID, "held@x.com");
    expect(clock).not.toHaveBeenCalled();
  });

  it("passes false through with the exact saleId + email", async () => {
    const { orders, service } = buildReadOnly(async () => false);
    expect(await service.hasOrdered(SALE_ID, "new@x.com")).toBe(false);
    expect(orders.hasOrdered).toHaveBeenCalledExactlyOnceWith(SALE_ID, "new@x.com");
  });

  it("port rejections propagate untouched (the 503 signal is the adapter's)", async () => {
    const boom = new Error("redis gone");
    const { service } = buildReadOnly(async () => {
      throw boom;
    });
    await expect(service.hasOrdered(SALE_ID, "x@x.com")).rejects.toBe(boom);
  });

  it("is a pure read: never runs the script, never audits, never charges, never publishes", async () => {
    const { orders, audit, payment, events, service } = buildReadOnly(async () => true);
    await service.hasOrdered(SALE_ID, "held@x.com");
    await drain();
    expect(orders.attempt).not.toHaveBeenCalled();
    expect(audit.recordOrder).not.toHaveBeenCalled();
    expect(payment.charge).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });
});
