// Unit tests for the sale-events broadcaster + window timers (Story 1.6
// AC 2/3/4/5) — vi.useFakeTimers() drives setTimeout/setInterval AND
// Date.now (the injected clock is backed by Date.now so coalescing
// elapsed-math and timers advance together); fake sale-status service,
// zero I/O. Pins the AD-9 mechanics exactly: leading-edge + trailing
// coalescing (<= 1 emit / 250 ms), terminal supersession (immediate, final
// frame), single serialized writer composing ONCE per emit via getStatus(),
// the 25 s named heartbeat event (AI-S4-07), fail-closed-on-compose-failure (AD-5), and
// future-boundaries-only timers with chunked re-arm below Node's setTimeout
// ceiling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COALESCE_MS,
  HEARTBEAT_MS,
  MAX_TIMEOUT_MS,
  armWindowTimers,
  createSaleEventsBroadcaster,
} from "../src/services/sale-events.ts";
import type { SaleStatusBody } from "../src/services/sale-status.ts";

const startTime = "2026-07-10T04:00:00.000Z";
const endTime = "2026-07-10T05:00:00.000Z";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Flush the fake-timer microtask queue so the serialized emit chain settles. */
const flush = () => vi.advanceTimersByTimeAsync(0);

function makeSaleStatus() {
  let body: SaleStatusBody = { success: true, status: "active", stock: 37, startTime, endTime };
  const getStatus = vi.fn(async () => ({ ...body }));
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

function build(overrides: { getStatus?: () => Promise<SaleStatusBody> } = {}) {
  const status = makeSaleStatus();
  const report = vi.fn();
  const broadcaster = createSaleEventsBroadcaster({
    saleStatus: { getStatus: overrides.getStatus ?? status.getStatus },
    clock: () => Date.now(),
    reportBroadcastFailure: report,
  });
  return { status, report, broadcaster };
}

describe("sale-events broadcaster — AC 3 snapshot + AC 4 coalescing/serialization", () => {
  it("exports the AD-9 spine constants (250 ms coalesce, 25 s heartbeat)", () => {
    expect(COALESCE_MS).toBe(250);
    expect(HEARTBEAT_MS).toBe(25_000);
  });

  it("snapshotFrame() is exactly `event: status` + the FR-1 body from a fresh getStatus() read", async () => {
    const { status, broadcaster } = build();
    const frame = await broadcaster.snapshotFrame();
    expect(frame).toBe(frameFor(status.body()));
    expect(status.getStatus).toHaveBeenCalledTimes(1);
  });

  it("a snapshotFrame() rejection propagates untouched (route -> central middleware -> 503)", async () => {
    const boom = new Error("redis gone");
    const { broadcaster } = build({ getStatus: async () => Promise.reject(boom) });
    await expect(broadcaster.snapshotFrame()).rejects.toBe(boom);
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
    expect(sink.written).toEqual(["event: heartbeat\ndata: {}\n\n"]); // named event, observable by the client watchdog (AI-S4-07)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(sink.written).toHaveLength(2);

    unregister();
    unregister(); // idempotent
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(sink.written).toHaveLength(2); // interval stopped
  });

  it("AI-S1-02 safety net: a sold_out observed on the heartbeat is broadcast once, even when the sale.sold_out publish was lost", async () => {
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

  it("AI-S1-02 safety net stays silent while the sale is still active", async () => {
    const { status, broadcaster } = build(); // default status: active
    const sink = makeSink();
    broadcaster.register(sink);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    // Only heartbeat events — never a status frame while active.
    expect(sink.written.every((c) => c === "event: heartbeat\ndata: {}\n\n")).toBe(true);
    expect(status.getStatus).toHaveBeenCalled(); // the safety net did probe
  });

  it("compose failure mid-stream: reportBroadcastFailure, every sink end()ed, subsequent events write nothing (AD-5)", async () => {
    const status = makeSaleStatus();
    const boom = new Error("redis gone mid-stream");
    status.getStatus.mockRejectedValueOnce(boom);
    const report = vi.fn();
    const broadcaster = createSaleEventsBroadcaster({
      saleStatus: { getStatus: status.getStatus },
      clock: () => Date.now(),
      reportBroadcastFailure: report,
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

describe("armWindowTimers — AC 2 future boundaries only", () => {
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
