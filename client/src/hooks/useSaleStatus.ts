// The realtime channel. An open stream is the sole writer of the status view —
// poll results apply only while it is down. That rule is an explicit guard
// here, never an accident of timing.
//
// `channel` is a separate axis from the sale's `status`: it is how honest the
// page may be about liveness, not what the sale is doing.
//
//   connecting — nothing read yet (cold load in flight)
//   live       — an EventSource is open; it alone writes `body`
//   degraded   — stream down, polling succeeding ("Live-ish")
//   offline    — stream down AND the last poll failed; the page stops
//                claiming liveness (the number may be stale)
//
// The hook takes a `slug` and threads it into every URL
// (`/api/sales/${slug}/status`, `/api/sales/${slug}/events`) rather than
// the v1.0 implicit-sale paths. It also exposes a `notFound` flag,
// orthogonal to `channel`: a 404 for the given slug is a TERMINAL outcome
// (this slug names no sale, so retrying is pointless) rather than a
// transient "unreachable" one — once set, every timer is torn down and the
// stream stays closed. The caller (SalePage) renders a friendly "Sale not
// found" page instead of the Noon Poster shell when `notFound` is true.
// `channel`'s own four states are left untouched so every existing consumer
// (SaleStatusZone, StatusChip, etc.) keeps its current meaning.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SaleNotFoundError,
  fetchSaleStatus,
  parseSaleStatus,
  saleEventsUrl,
  type SaleStatusBody,
} from "../api/sale.ts";

export type Channel = "connecting" | "live" | "degraded" | "offline";

/** Middle of the spine's 2–10 s fallback band. */
export const POLL_MS = 5_000;

/** The server heartbeats every 25 s as a named `heartbeat` event, which the
 *  browser surfaces — so a quiet-but-live stream keeps marking activity even
 *  when no `status` frame is due (e.g. the whole `upcoming` phase). If an open
 *  stream produces no observable activity for longer than this, the connection
 *  is treated as silently dead — a black-holed TCP socket (sleep/wake, captive
 *  portal, NAT reap) that never fires `error`. The demotion self-heals: the
 *  reconnect below re-snapshots. */
export const WATCHDOG_SILENCE_MS = 40_000;

/** If neither channel has produced a first paint by this deadline, arm the
 *  fallback — a stream that hangs before headers must not strand the page. */
export const CONNECT_DEADLINE_MS = 6_000;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface SaleStatusHandle {
  body: SaleStatusBody | null;
  channel: Channel;
  /** True once the API has confirmed the slug names no sale (404). Terminal —
   *  once set, no further poll/reconnect activity happens. */
  notFound: boolean;
  /** One-shot re-sync, called after every order attempt. */
  refetch: () => void;
}

export function useSaleStatus(slug: string): SaleStatusHandle {
  const [body, setBody] = useState<SaleStatusBody | null>(null);
  const [channel, setChannel] = useState<Channel>("connecting");
  const [notFound, setNotFound] = useState(false);

  const channelRef = useRef<Channel>("connecting");
  const mountedRef = useRef(true);
  const notFoundRef = useRef(false);
  const sourceRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const lastActivityRef = useRef(0);

  const setChannelSafely = useCallback((next: Channel) => {
    channelRef.current = next;
    if (mountedRef.current) {
      setChannel(next);
    }
  }, []);

  /** The stream's writes always land. */
  const writeFromStream = useCallback((next: SaleStatusBody) => {
    if (mountedRef.current) {
      setBody(next);
    }
  }, []);

  /** A poll's write lands ONLY while the stream is down (the sole-writer rule). */
  const writeFromPoll = useCallback((next: SaleStatusBody) => {
    if (mountedRef.current && channelRef.current !== "live") {
      setBody(next);
    }
  }, []);

  const refetch = useCallback(() => {
    if (notFoundRef.current) {
      // Terminal outcome — no further re-sync is possible or useful.
      return;
    }
    void fetchSaleStatus(slug)
      .then((next) => {
        // A re-sync obeys the SAME sole-writer rule as a poll: while the stream
        // is live it alone writes `body`, so a re-sync GET (an independent Redis
        // read with no ordering guarantee) can NOT rewind the counter behind a
        // newer frame or resurrect an `active` body over a `sold_out` one. The
        // stream delivers the post-order frame anyway (the server emits on
        // `order.accepted`); this only carries the page while the stream is down.
        if (mountedRef.current && channelRef.current !== "live") {
          setBody(next);
        }
      })
      .catch(() => {
        // Silent: a re-sync failure is not a verdict, and the status zone
        // keeps whatever truth it has. (A 404 here — the sale vanishing
        // mid-session — is an edge case not worth a dedicated path; the next
        // cold navigation to the slug will surface "Sale not found" via the
        // normal mount-time flow.)
      });
  }, [slug]);

  useEffect(() => {
    mountedRef.current = true;
    // A fresh effect run (new slug, or a remount) starts from a clean slate —
    // a stale `notFound` from a PREVIOUS slug must never haunt a new one.
    notFoundRef.current = false;
    setNotFound(false);
    const controller = new AbortController();

    const stopPolling = () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    const stopReconnect = () => {
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const closeStream = () => {
      if (sourceRef.current !== null) {
        sourceRef.current.close();
        sourceRef.current = null;
      }
    };

    const markActivity = () => {
      lastActivityRef.current = Date.now();
    };

    /** The slug names no sale — a terminal outcome. Tear everything down and
     *  never retry: every subsequent poll/reconnect entry point checks this
     *  ref first and becomes inert. */
    const markNotFound = () => {
      if (notFoundRef.current) {
        return;
      }
      notFoundRef.current = true;
      if (mountedRef.current) {
        setNotFound(true);
      }
      stopPolling();
      stopReconnect();
      closeStream();
    };

    const openStream = () => {
      if (notFoundRef.current) {
        return;
      }
      closeStream();
      markActivity();
      const source = new EventSource(saleEventsUrl(slug));
      sourceRef.current = source;

      source.onopen = () => {
        if (!mountedRef.current || notFoundRef.current) {
          return;
        }
        markActivity();
        // A clean connect means the retry budget is spent — reset it and stop
        // the reconnect scheduler; the stream is the sole writer again.
        reconnectAttemptsRef.current = 0;
        stopReconnect();
        // RECOVERY, not first connect: the server snapshots on every connect,
        // so a cold open needs nothing extra. It is the recovery case that must
        // not leave a frame from the outage on screen.
        const recovering = channelRef.current === "degraded" || channelRef.current === "offline";
        setChannelSafely("live");
        stopPolling();
        if (recovering) {
          // Re-sync ONCE. Belt to the snapshot's braces — correct even if the
          // snapshot frame is lost in flight.
          void fetchSaleStatus(slug, controller.signal).then(writeFromStream).catch(() => {});
        }
      };

      // The server names its event `status` — a bare onmessage handler would
      // receive NOTHING (onmessage fires only for unnamed events).
      source.addEventListener("status", (event) => {
        markActivity();
        let raw: unknown;
        try {
          raw = JSON.parse((event as MessageEvent<string>).data);
        } catch {
          // Malformed SSE frame — ignore it; the UI keeps whatever state it had.
          return;
        }
        const next = parseSaleStatus(raw);
        if (next !== null) {
          writeFromStream(next);
        }
      });

      // The 25 s keep-alive is a named `heartbeat` event. It carries no
      // status — its only job is to mark the stream observably alive so the
      // watchdog does not demote a healthy but quiet connection.
      source.addEventListener("heartbeat", markActivity);

      source.onerror = () => {
        if (!mountedRef.current || notFoundRef.current) {
          return;
        }
        // Drop the liveness claim THE MOMENT the stream falters — before any
        // poll resolves. Leaving `live` set here would silently keep discarding
        // polls (the sole-writer guard) and strand the page on a frozen number
        // while insisting it was live.
        if (channelRef.current === "live") {
          setChannelSafely("degraded");
        }
        // `error` with readyState CONNECTING is a RECOVERABLE mid-stream drop:
        // the browser is already reconnecting natively. Tearing the source down
        // here (the old behavior) permanently defeats that. Keep it and let it
        // retry; only a CLOSED source is fatal (e.g. a 503 handshake) and needs
        // our own reconnect. Either way the fallback poll carries the page.
        if (source.readyState !== EventSource.CONNECTING) {
          closeStream();
        }
        startFallback();
        scheduleReconnect();
      };
    };

    /** `fromFallback` marks the polls that are *carrying* the page (the stream
     *  is known down). Only those may claim "degraded" or admit "offline" —
     *  the cold-load poll paints, but the stream's own outcome decides the
     *  channel, so the sticker never flashes a claim it hasn't earned. */
    const pollOnce = (fromFallback: boolean) => {
      if (notFoundRef.current) {
        return;
      }
      void fetchSaleStatus(slug, controller.signal)
        .then((next) => {
          if (!mountedRef.current || channelRef.current === "live") {
            return;
          }
          writeFromPoll(next);
          if (fromFallback) {
            setChannelSafely("degraded");
          }
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) {
            return;
          }
          // Terminal: this slug names no sale. Stop retrying for good — no
          // amount of polling will ever turn a 404 into a 200.
          if (err instanceof SaleNotFoundError) {
            markNotFound();
            return;
          }
          if (channelRef.current === "live") {
            return;
          }
          if (fromFallback) {
            // Both channels unreachable: stop claiming liveness. `body` is
            // left untouched — stale-but-marked, or null on a cold load.
            setChannelSafely("offline");
          } else {
            // A cold poll failed while the stream is still connecting. Do not
            // sit on "connecting" with no timer armed — arm the fallback so a
            // hung pre-headers handshake can't strand the page forever.
            startFallback();
            scheduleReconnect();
          }
        });
    };

    function startFallback() {
      if (notFoundRef.current) {
        return;
      }
      if (timerRef.current !== null) {
        // Guard: only one poll interval may run at a time.
        return;
      }
      pollOnce(true);
      timerRef.current = setInterval(() => {
        pollOnce(true);
      }, POLL_MS);
    }

    /** Reconnect the stream on an exponential backoff with equal jitter. A
     *  server-side close ends every client's stream at the same instant; a fixed
     *  interval would have them all reconnect in lockstep. Jitter spreads them. */
    function reconnectDelay() {
      const capped = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttemptsRef.current);
      return capped / 2 + Math.random() * (capped / 2);
    }

    function scheduleReconnect() {
      if (notFoundRef.current) {
        return;
      }
      if (reconnectTimerRef.current !== null) {
        // Guard: only one reconnect timer may run at a time.
        return;
      }
      const attempt = () => {
        reconnectTimerRef.current = null;
        if (!mountedRef.current || notFoundRef.current || channelRef.current === "live") {
          return;
        }
        const current = sourceRef.current;
        if (current !== null && current.readyState === EventSource.CONNECTING) {
          // An in-flight handshake — do NOT kill it. Check back after a beat.
          reconnectAttemptsRef.current += 1;
          reconnectTimerRef.current = setTimeout(attempt, reconnectDelay());
          return;
        }
        openStream();
        reconnectAttemptsRef.current += 1;
        reconnectTimerRef.current = setTimeout(attempt, reconnectDelay());
      };
      reconnectTimerRef.current = setTimeout(attempt, reconnectDelay());
    }

    // A silently-dead stream fires no `error`. Poll our own last-activity clock
    // and treat prolonged silence on a live stream as death. The demotion is
    // cheap and self-healing: the reconnect re-snapshots within a beat.
    const watchdog = setInterval(() => {
      if (!mountedRef.current || notFoundRef.current) {
        return;
      }
      if (channelRef.current === "live" && Date.now() - lastActivityRef.current > WATCHDOG_SILENCE_MS) {
        closeStream();
        setChannelSafely("degraded");
        startFallback();
        scheduleReconnect();
      }
    }, WATCHDOG_SILENCE_MS / 4);

    // Cold load: open the stream AND read the status, so the first paint is
    // whichever answers first. There is no skeleton — the first response IS
    // the loading end.
    openStream();
    pollOnce(false);

    // A stream that hangs before headers fires neither `open` nor `error`. If
    // we are still `connecting` at the deadline, carry the page by polling.
    const connectDeadline = setTimeout(() => {
      if (mountedRef.current && channelRef.current === "connecting" && !notFoundRef.current) {
        startFallback();
        scheduleReconnect();
      }
    }, CONNECT_DEADLINE_MS);

    return () => {
      mountedRef.current = false;
      controller.abort();
      clearTimeout(connectDeadline);
      clearInterval(watchdog);
      stopReconnect();
      stopPolling();
      closeStream();
    };
  }, [slug, setChannelSafely, writeFromPoll, writeFromStream]);

  return { body, channel, notFound, refetch };
}
