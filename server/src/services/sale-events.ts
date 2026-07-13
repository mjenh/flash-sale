// Sale-events broadcaster — owns the AD-9 realtime rules: coalescing
// (<= 1 broadcast per 250 ms; terminal transitions immediate, superseding any
// pending coalesced emit, always the final frame), a single serialized writer
// composing every frame ONCE via the sale-status service (the SOLE owner of
// the status state machine — a fresh Redis read at emit time, never
// decision-time state), snapshot-on-connect (healing missed events — no
// replay), the 25 s heartbeat comment, and the mid-stream form of fail-closed
// (AD-5: if truth cannot be read, streams close rather than serve staleness).
//
// Also owns the AD-9 window-boundary timers: boot arms sale.started /
// sale.ended for FUTURE boundaries only (AD-6: the injected clock decides);
// elapsed boundaries arm nothing — snapshot-on-connect heals.
//
// Framework-free (AD-7): no express/redis/mongoose imports — sinks are a
// structural { write; end } surface the SSE route satisfies with `res`, and
// the publisher arrives as an injected function.
import type { Clock } from "./clock.ts";
import type { SaleStatus, SaleStatusService } from "./sale-status.ts";

/** Type-only domain events on the `sale:events` channel (AD-9). */
export type SaleEventType = "order.accepted" | "sale.sold_out" | "sale.started" | "sale.ended";

/** Terminal transitions: emit immediately, supersede pending, final frame. */
const TERMINAL_EVENTS: ReadonlySet<string> = new Set(["sale.sold_out", "sale.ended"]);

/** AD-9 spine constants — not deployment tunables (no config keys). */
export const COALESCE_MS = 250;
export const HEARTBEAT_MS = 25_000;

/** Node's setTimeout ceiling; longer boundary delays re-arm in chunks. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

const HEARTBEAT_FRAME = ": heartbeat\n\n";

/** One `status` event carrying the FR-1 body — the only frame type ever sent. */
function formatStatusFrame(body: unknown): string {
  return `event: status\ndata: ${JSON.stringify(body)}\n\n`;
}

/** Structural connection surface — the SSE route satisfies it with `res`. */
export interface SseSink {
  write(chunk: string): void;
  end(): void;
}

export interface SaleEventsBroadcaster {
  /** Snapshot-on-connect frame (fresh Redis read via the sale-status
   *  service). A RedisUnavailableError rejection propagates untouched —
   *  the route lets it reach the central middleware BEFORE headers are
   *  sent, so new streams 503 while Redis is down (AD-5). */
  snapshotFrame(): Promise<string>;
  /** Adds a connection; returns an idempotent unregister function. The
   *  shared heartbeat interval runs lazily while >= 1 sink is registered. */
  register(sink: SseSink): () => void;
  /** The coalescing gate — fed by the Redis pub/sub subscriber. */
  onDomainEvent(event: string): void;
  /** AD-5 mid-stream fail-closed: end every stream, stop timers. */
  closeAll(): void;
  /** Teardown alias used by bootstrap. */
  stop(): void;
}

export interface SaleEventsBroadcasterDeps {
  saleStatus: SaleStatusService;
  clock: Clock;
  /** Compose failures are reported here (bootstrap wires logger.error),
   *  then every stream is closed — never thrown into a request path. */
  reportBroadcastFailure: (err: unknown) => void;
  /** Test-only overrides; production uses the AD-9 spine constants. */
  coalesceMs?: number;
  heartbeatMs?: number;
}

export function createSaleEventsBroadcaster({
  saleStatus,
  clock,
  reportBroadcastFailure,
  coalesceMs = COALESCE_MS,
  heartbeatMs = HEARTBEAT_MS,
}: SaleEventsBroadcasterDeps): SaleEventsBroadcaster {
  const sinks = new Set<SseSink>();
  let heartbeat: NodeJS.Timeout | undefined;
  let pending: NodeJS.Timeout | undefined;
  let lastEmitAt = Number.NEGATIVE_INFINITY;
  /** Set once a terminal frame (sold_out/ended) has gone out — by the domain
   *  event OR the AI-S1-02 safety net below — so the safety net fires at most
   *  once and stops polling thereafter. */
  let sawTerminal = false;
  /** The single serialized writer (AD-9): every emit appends here, so frames
   *  always land in order and a terminal emit is provably the final frame. */
  let chain: Promise<void> = Promise.resolve();

  const stopHeartbeat = (): void => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };

  const drop = (sink: SseSink): void => {
    sinks.delete(sink);
    if (sinks.size === 0) {
      stopHeartbeat();
    }
  };

  const writeTo = (sink: SseSink, chunk: string): void => {
    try {
      sink.write(chunk);
    } catch {
      // A dead socket is dropped, never propagated into the writer chain.
      drop(sink);
    }
  };

  /** AI-S1-02 safety net. An order can commit its Lua script (SADD+DECR to 0)
   *  and still be answered 503 on a Redis command timeout, skipping the OK
   *  branch — so the ONE sale.sold_out publish is lost and live streams stay
   *  stranded on "active" indefinitely (a healthy stream never reconnects, so
   *  snapshot-on-connect can't heal it). Piggybacked on the heartbeat: if a
   *  fresh read shows the sale is sold out and no terminal frame has gone out,
   *  broadcast one, exactly once. A read failure is not a signal (the normal
   *  AD-5 fail-closed paths own Redis-down); observing `ended` also stops the
   *  poll (that boundary is a reliable timer, and snapshot heals reconnects). */
  const ensureTerminalIfSoldOut = async (): Promise<void> => {
    if (sawTerminal || sinks.size === 0) {
      return;
    }
    let status: SaleStatus;
    try {
      ({ status } = await saleStatus.getStatus());
    } catch {
      return;
    }
    if (sawTerminal || sinks.size === 0) {
      return; // state changed while the read was in flight
    }
    if (status === "sold_out") {
      sawTerminal = true;
      emit(); // composes a fresh sold_out frame to every sink via the chain
    } else if (status === "ended") {
      sawTerminal = true; // terminal; stop polling — snapshot heals reconnects
    }
  };

  const startHeartbeat = (): void => {
    if (heartbeat !== undefined) {
      return;
    }
    heartbeat = setInterval(() => {
      for (const sink of [...sinks]) {
        writeTo(sink, HEARTBEAT_FRAME);
      }
      if (!sawTerminal) {
        void ensureTerminalIfSoldOut();
      }
    }, heartbeatMs);
    heartbeat.unref();
  };

  const cancelPending = (): void => {
    if (pending !== undefined) {
      clearTimeout(pending);
      pending = undefined;
    }
  };

  const closeAll = (): void => {
    cancelPending();
    stopHeartbeat();
    for (const sink of [...sinks]) {
      try {
        sink.end();
      } catch {
        // Ending an already-dead socket is fine.
      }
    }
    sinks.clear();
  };

  /** Compose ONCE via the sale-status service, write the identical frame to
   *  every connection. On compose failure: report, then close every stream
   *  (fail closed mid-stream, AD-5). */
  const emit = (): void => {
    lastEmitAt = clock();
    chain = chain
      .then(async () => {
        if (sinks.size === 0) {
          return; // nobody listening — skip the read entirely
        }
        const frame = formatStatusFrame(await saleStatus.getStatus());
        for (const sink of [...sinks]) {
          writeTo(sink, frame);
        }
      })
      .catch((err: unknown) => {
        reportBroadcastFailure(err);
        closeAll();
      });
  };

  return {
    async snapshotFrame(): Promise<string> {
      return formatStatusFrame(await saleStatus.getStatus());
    },

    register(sink: SseSink): () => void {
      sinks.add(sink);
      startHeartbeat();
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        drop(sink);
      };
    },

    onDomainEvent(event: string): void {
      if (TERMINAL_EVENTS.has(event)) {
        // Immediate + supersedes: the pending coalesced emit is dropped, and
        // the serialized chain guarantees this frame lands last.
        sawTerminal = true; // the terminal frame is going out — disarm the safety net
        cancelPending();
        emit();
        return;
      }
      if (pending !== undefined) {
        return; // one trailing emit already absorbs this burst
      }
      const elapsed = clock() - lastEmitAt;
      if (elapsed >= coalesceMs) {
        emit(); // leading edge — first event after a quiet period is instant
        return;
      }
      pending = setTimeout(() => {
        pending = undefined;
        emit();
      }, coalesceMs - elapsed);
      pending.unref();
    },

    closeAll,
    stop: closeAll,
  };
}

export interface WindowTimers {
  cancel(): void;
}

export interface ArmWindowTimersDeps {
  clock: Clock;
  startMs: number;
  endMs: number;
  publish: (event: "sale.started" | "sale.ended") => Promise<void>;
  /** Publish failures are logged consequences, never thrown (AD-9). */
  onPublishFailure: (err: unknown) => void;
}

/** Arm sale.started / sale.ended timers for FUTURE boundaries only (AD-9).
 *  Timers re-check the injected clock on fire (drift-tolerant) and re-arm in
 *  chunks below Node's setTimeout ceiling; all timers are unref()'d. */
export function armWindowTimers({
  clock,
  startMs,
  endMs,
  publish,
  onPublishFailure,
}: ArmWindowTimersDeps): WindowTimers {
  const timers = new Set<NodeJS.Timeout>();
  let cancelled = false;

  const armAt = (boundaryMs: number, event: "sale.started" | "sale.ended"): void => {
    if (boundaryMs <= clock()) {
      return; // elapsed boundary — emit nothing; snapshot-on-connect heals
    }
    const schedule = (): void => {
      const remaining = boundaryMs - clock();
      const timer = setTimeout(
        () => {
          timers.delete(timer);
          if (cancelled) {
            return;
          }
          if (boundaryMs > clock()) {
            schedule(); // chunked re-arm (ceiling) / early wake — not yet due
            return;
          }
          void publish(event).catch((err: unknown) => {
            onPublishFailure(err);
          });
        },
        Math.min(Math.max(remaining, 0), MAX_TIMEOUT_MS),
      );
      timer.unref();
      timers.add(timer);
    };
    schedule();
  };

  armAt(startMs, "sale.started");
  armAt(endMs, "sale.ended");

  return {
    cancel(): void {
      cancelled = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    },
  };
}
