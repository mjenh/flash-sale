// vi.useFakeTimers() drives setTimeout/setInterval AND Date.now (the
// injected clock is backed by Date.now so coalescing elapsed-math and timers
// advance together); fake sale-status service, zero I/O. Pins the mechanics
// exactly: leading-edge + trailing coalescing (<= 1 emit / 250 ms), terminal
// supersession (immediate, final frame), single serialized writer composing
// ONCE per emit via getStatus(), the 25 s named heartbeat event,
// fail-closed-on-compose-failure, and future-boundaries-only timers with
// chunked re-arm below Node's setTimeout ceiling.
//
// getStatus(saleId, window) takes both per call, and the broadcaster's
// pubsub/heartbeat-driven paths (emit, the sold-out safety net) resolve
// them via the injected getActiveSale() rather than a frozen window dep.
// SALE_ID/WINDOW below stand in for "the currently active sale" throughout —
// getActiveSale() always resolves to them unless a test overrides it, so
// every existing timer/coalescing/heartbeat invariant is unchanged; only
// the wiring that feeds getStatus() its saleId/window moved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COALESCE_MS,
  HEARTBEAT_MS,
  MAX_TIMEOUT_MS,
  armWindowTimers,
  createSaleEventsBroadcaster,
} from "../src/services/sale-events.ts";
import type { SaleStatusBody, SaleWindow } from "../src/services/sale-status.ts";
import { START_MS, END_MS, START_ISO, END_ISO } from "./helpers/time-fixtures.ts";

const SALE_ID = "sale-1";
const WINDOW: SaleWindow = {
  startMs: START_MS,
  endMs: END_MS,
  startIso: START_ISO,
  endIso: END_ISO,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Flush the fake-timer microtask queue so the serialized emit chain settles. */
const flush = () => vi.advanceTimersByTimeAsync(0);

function makeSaleStatus() {
  let body: SaleStatusBody = { success: true, status: "active", stock: 37, startTime: START_ISO, endTime: END_ISO };
  const getStatus = vi.fn(async (_saleId: string, _window: SaleWindow) => ({ ...body }));
  return {
    getStatus,
    set(patch: Partial<SaleStatusBody>) {
      body = { ...body, ...patch } as SaleStatusBody;
    },
    body: () => ({ ...body }),
  };
}

function makeSink() {
  const written: string[] = [];
  let ended = 0;
  return {
    written,
    endedCount: () => ended,
    write(chunk: string) {
      written.push(chunk);
    },
    end() {
      ended += 1;
    },
  };
}

function frameFor(body: SaleStatusBody): string {
  return `event: status\ndata: ${JSON.stringify(body)}\n\n`;
}

function build(
  overrides: {
    getStatus?: (saleId: string, window: SaleWindow) => Promise<SaleStatusBody>;
    getActiveSale?: () => Promise<{ saleId: string; window: SaleWindow }>;
  } = {},
) {
  const status = makeSaleStatus();
  const report = vi.fn();
  const getActiveSale = vi.fn(overrides.getActiveSale ?? (async () => ({ saleId: SALE_ID, window: WINDOW })));
  const broadcaster = createSaleEventsBroadcaster({
    saleStatus: { getStatus: overrides.getStatus ?? status.getStatus },
    clock: () => Date.now(),
    reportBroadcastFailure: report,
    getActiveSale,
  });
  return { status, report, getActiveSale, broadcaster };
}

describe("sale-events broadcaster — snapshot + coalescing/serialization", () => {
  it("exports the spine constants (250 ms coalesce, 25 s heartbeat)", () => {
    expect(COALESCE_MS).toBe(250);
    expect(HEARTBEAT_MS).toBe(25_000);
  });

  it("snapshotFrame(saleId, window) is exactly `event: status` + the body from a fresh getStatus() read, called with the exact args", async () => {
    const { status, broadcaster } = build();
    const frame = await broadcaster.snapshotFrame(SALE_ID, WINDOW);
    expect(frame).toBe(frameFor(status.body()));
    expect(status.getStatus).toHaveBeenCalledExactlyOnceWith(SALE_ID, WINDOW);
  });

  it("a snapshotFrame() rejection propagates untouched (route -> central middleware -> 503)", async () => {
    const boom = new Error("redis gone");
    const { broadcaster } = build({ getStatus: async () => Promise.reject(boom) });
    await expect(broadcaster.snapshotFrame(SALE_ID, WINDOW)).rejects.toBe(boom);
  });

  it("first event after a quiet period emits immediately (leading edge) — identical frame to every sink, ONE getStatus per emit", async () => {
    const { status, broadcaster } = build();
    const a = makeSink();
    const b = makeSink();
    broadcaster.register(a);
    broadcaster.register(b);

    broadcaster.onDomainEvent("order.accepted");
    await flush();

    const expected = frameFor(status.body());
    expect(a.written).toEqual([expected]);
    expect(b.written).toEqual([expected]);
    expect(status.getStatus).toHaveBeenCalledTimes(1);
  });

  it("a burst of 5 events inside 250 ms -> exactly 1 immediate + 1 trailing emit; the trailing frame is a FRESH read", async () => {
    const { status, broadcaster } = build();
    const sink = makeSink();
    broadcaster.register(sink);

    broadcaster.onDomainEvent("order.accepted"); // leading edge
    await flush();
    expect(sink.written).toHaveLength(1);

    status.set({ stock: 32 }); // the truth moves while the burst is absorbed
    for (let i = 0; i < 4; i += 1) {
      broadcaster.onDomainEvent("order.accepted");
    }
    await flush();
    expect(sink.written).toHaveLength(1); // absorbed — nothing until the window closes

    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(sink.written).toHaveLength(2); // <= 1 per 250 ms proven
    expect(sink.written[1]).toBe(frameFor(status.body())); // stock 32 — fresh read at emit time
    expect(status.getStatus).toHaveBeenCalledTimes(2);
  });

  it("a terminal event during a pending window cancels the trailing emit, emits immediately, and is the FINAL frame", async () => {
    const { status, broadcaster } = build();
    const sink = makeSink();
    broadcaster.register(sink);

    broadcaster.onDomainEvent("order.accepted"); // leading edge (frame 1)
    await flush();
    broadcaster.onDomainEvent("order.accepted"); // schedules the trailing emit
    await flush();
    expect(sink.written).toHaveLength(1);

    status.set({ status: "sold_out", stock: 0 });
    broadcaster.onDomainEvent("sale.sold_out"); // terminal: supersede + immediate
    await flush();
    expect(sink.written).toHaveLength(2);
    expect(sink.written[1]).toBe(frameFor(status.body()));

    await vi.advanceTimersByTimeAsync(COALESCE_MS * 4); // the cancelled trailing emit never fires
    expect(sink.written).toHaveLength(2);
    expect(status.getStatus).toHaveBeenCalledTimes(2);
  });

  it("sale.ended is terminal too — immediate even right after an emit", async () => {
    const { broadcaster } = build();
    const sink = makeSink();
    broadcaster.register(sink);

    broadcaster.onDomainEvent("order.accepted");
    await flush();
    broadcaster.onDomainEvent("sale.ended"); // inside the 250 ms window, still immediate
    await flush();
    expect(sink.written).toHaveLength(2);
  });

  it("writes the named heartbeat EVENT frame every 25 s while a sink is registered; the interval stops with the last sink", async () => {
    const { broadcaster } = build();
    const sink = makeSink();
    const unregister = broadcaster.register(sink);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(sink.written).toEqual(["event: heartbeat\ndata: {}\n\n"]); // named event, observable by the client watchdog
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(sink.written).toHaveLength(2);

    unregister();
    unregister(); // idempotent
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(sink.written).toHaveLength(2); // interval stopped
  });

  it("safety net: a sold_out observed on the heartbeat is broadcast once, even when the sale.sold_out publish was lost", async () => {
    const { status, broadcaster } = build();
    const sink = makeSink();
    broadcaster.register(sink);

    // The order's Lua script committed (stock 0) but it was answered 503 on a
    // Redis timeout, so its sale.sold_out publish never fired — no onDomainEvent.
    // The live stream is stranded on "active" with no reconnect to heal it.
    status.set({ status: "sold_out", stock: 0 });

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    const soldOutFrame = frameFor(status.body());
    expect(sink.written).toContain("event: heartbeat\ndata: {}\n\n");
    expect(sink.written).toContain(soldOutFrame); // recovered terminal frame

    // Idempotent: subsequent heartbeats do not re-broadcast it.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(sink.written.filter((c) => c === soldOutFrame)).toHaveLength(1);
  });

  it("safety net stays silent while the sale is still active", async () => {
    const { status, broadcaster } = build(); // default status: active
    const sink = makeSink();
    broadcaster.register(sink);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    // Only heartbeat events — never a status frame while active.
    expect(sink.written.every((c) => c === "event: heartbeat\ndata: {}\n\n")).toBe(true);
    expect(status.getStatus).toHaveBeenCalled(); // the safety net did probe
  });

  it("compose failure mid-stream: reportBroadcastFailure, every sink end()ed, subsequent events write nothing", async () => {
    const status = makeSaleStatus();
    const boom = new Error("redis gone mid-stream");
    status.getStatus.mockRejectedValueOnce(boom);
    const report = vi.fn();
    const broadcaster = createSaleEventsBroadcaster({
      saleStatus: { getStatus: status.getStatus },
      clock: () => Date.now(),
      reportBroadcastFailure: report,
      getActiveSale: async () => ({ saleId: SALE_ID, window: WINDOW }),
    });
    const a = makeSink();
    const b = makeSink();
    broadcaster.register(a);
    broadcaster.register(b);

    broadcaster.onDomainEvent("order.accepted");
    await flush();
    expect(report).toHaveBeenCalledExactlyOnceWith(boom);
    expect(a.endedCount()).toBe(1);
    expect(b.endedCount()).toBe(1);

    broadcaster.onDomainEvent("order.accepted");
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 4);
    expect(a.written).toEqual([]);
    expect(b.written).toEqual([]);
  });

  it("closeAll() ends every sink, cancels the pending coalesced emit, and stops the heartbeat", async () => {
    const { status, broadcaster } = build();
    const sink = makeSink();
    broadcaster.register(sink);

    broadcaster.onDomainEvent("order.accepted"); // leading edge
    await flush();
    broadcaster.onDomainEvent("order.accepted"); // pending trailing emit
    broadcaster.closeAll();

    expect(sink.endedCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(sink.written).toHaveLength(1); // no trailing frame, no heartbeat
    expect(status.getStatus).toHaveBeenCalledTimes(1);
  });

  it("a sink whose write throws is dropped; the rest keep receiving frames", async () => {
    const { broadcaster } = build();
    const dead = {
      write: vi.fn(() => {
        throw new Error("EPIPE");
      }),
      end: vi.fn(),
    };
    const alive = makeSink();
    broadcaster.register(dead);
    broadcaster.register(alive);

    broadcaster.onDomainEvent("order.accepted");
    await flush();
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    broadcaster.onDomainEvent("order.accepted");
    await flush();

    expect(dead.write).toHaveBeenCalledTimes(1); // dropped after the first failure
    expect(alive.written).toHaveLength(2);
  });
});

describe("dynamic active-sale resolution for pubsub/heartbeat-driven composition", () => {
  it("emit() re-derives the active sale via getActiveSale() on every call, then composes getStatus() with that saleId/window", async () => {
    const { status, getActiveSale, broadcaster } = build();
    const sink = makeSink();
    broadcaster.register(sink);

    broadcaster.onDomainEvent("order.accepted");
    await flush();

    expect(getActiveSale).toHaveBeenCalledTimes(1);
    expect(status.getStatus).toHaveBeenCalledExactlyOnceWith(SALE_ID, WINDOW);
  });

  it("a changed active sale between emits is reflected in the next composed frame — not frozen at construction", async () => {
    const OTHER_ID = "sale-2";
    const OTHER_WINDOW: SaleWindow = {
      startMs: START_MS + 60_000,
      endMs: END_MS + 60_000,
      startIso: new Date(START_MS + 60_000).toISOString(),
      endIso: new Date(END_MS + 60_000).toISOString(),
    };
    let active = { saleId: SALE_ID, window: WINDOW };
    const status = makeSaleStatus();
    const broadcaster = createSaleEventsBroadcaster({
      saleStatus: { getStatus: status.getStatus },
      clock: () => Date.now(),
      reportBroadcastFailure: vi.fn(),
      getActiveSale: async () => active,
    });
    const sink = makeSink();
    broadcaster.register(sink);

    broadcaster.onDomainEvent("order.accepted");
    await flush();
    expect(status.getStatus).toHaveBeenLastCalledWith(SALE_ID, WINDOW);

    // Simulate the resolver now pointing at a different active sale.
    active = { saleId: OTHER_ID, window: OTHER_WINDOW };
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    broadcaster.onDomainEvent("order.accepted");
    await flush();
    expect(status.getStatus).toHaveBeenLastCalledWith(OTHER_ID, OTHER_WINDOW);
  });

  it("the sold-out safety net (heartbeat-driven) also resolves saleId/window via getActiveSale()", async () => {
    const { status, getActiveSale, broadcaster } = build();
    status.set({ status: "sold_out", stock: 0 });
    const sink = makeSink();
    broadcaster.register(sink);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(getActiveSale).toHaveBeenCalled();
    expect(status.getStatus).toHaveBeenCalledWith(SALE_ID, WINDOW);
  });

  it("snapshotFrame(saleId, window) uses the explicit args, independent of getActiveSale()", async () => {
    const { status, getActiveSale, broadcaster } = build();
    const OTHER_ID = "sale-2";
    await broadcaster.snapshotFrame(OTHER_ID, WINDOW);
    expect(status.getStatus).toHaveBeenCalledExactlyOnceWith(OTHER_ID, WINDOW);
    expect(getActiveSale).not.toHaveBeenCalled(); // connect-time snapshot never consults it
  });
});

describe("armWindowTimers — future boundaries only", () => {
  function arm(opts: { startOffsetMs: number; endOffsetMs: number; publish?: () => Promise<void> }) {
    const publish = vi.fn(opts.publish ?? (async () => {}));
    const onPublishFailure = vi.fn();
    const now = Date.now();
    const timers = armWindowTimers({
      clock: () => Date.now(),
      startMs: now + opts.startOffsetMs,
      endMs: now + opts.endOffsetMs,
      publish,
      onPublishFailure,
    });
    return { publish, onPublishFailure, timers };
  }

  it("boot before start arms both boundaries; each publishes exactly once, at its boundary", async () => {
    const { publish } = arm({ startOffsetMs: 1000, endOffsetMs: 3000 });

    await vi.advanceTimersByTimeAsync(999);
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledExactlyOnceWith("sale.started");

    await vi.advanceTimersByTimeAsync(1999);
    expect(publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith("sale.ended");

    await vi.advanceTimersByTimeAsync(60_000); // never again
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("boot mid-window arms ONLY sale.ended — the elapsed start boundary publishes nothing (snapshot heals)", async () => {
    const { publish } = arm({ startOffsetMs: -1000, endOffsetMs: 1000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenCalledExactlyOnceWith("sale.ended");
  });

  it("boot after end arms NOTHING — zero publishes ever", async () => {
    const { publish } = arm({ startOffsetMs: -3000, endOffsetMs: -1000 });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(publish).not.toHaveBeenCalled();
  });

  it("a publish rejection reaches onPublishFailure — nothing is thrown", async () => {
    const boom = new Error("publish failed");
    const { onPublishFailure } = arm({
      startOffsetMs: 1000,
      endOffsetMs: 60_000,
      publish: async () => {
        throw boom;
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(onPublishFailure).toHaveBeenCalledExactlyOnceWith(boom);
  });

  it("cancel() prevents both boundary publishes", async () => {
    const { publish, timers } = arm({ startOffsetMs: 1000, endOffsetMs: 2000 });
    timers.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(publish).not.toHaveBeenCalled();
  });

  it("a boundary beyond Node's 2**31 - 1 ms setTimeout ceiling re-arms in chunks instead of firing early", async () => {
    const { publish, timers } = arm({
      startOffsetMs: MAX_TIMEOUT_MS + 5000,
      endOffsetMs: MAX_TIMEOUT_MS * 3,
    });

    await vi.advanceTimersByTimeAsync(MAX_TIMEOUT_MS);
    expect(publish).not.toHaveBeenCalled(); // ceiling chunk elapsed — re-armed, not fired

    await vi.advanceTimersByTimeAsync(5000);
    expect(publish).toHaveBeenCalledExactlyOnceWith("sale.started");
    timers.cancel();
  });
});
