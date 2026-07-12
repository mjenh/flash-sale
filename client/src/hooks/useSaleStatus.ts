// The realtime channel. An OPEN STREAM IS THE SOLE WRITER of the status view
// (AD-9 / frontend-behavior convention) — poll results apply only while it is
// down. That rule is an explicit guard here, never an accident of timing.
//
// `channel` is a separate axis from the sale's `status`: it is how honest the
// page may be about liveness, not what the sale is doing.
//
//   connecting — nothing read yet (cold load in flight)
//   live       — an EventSource is open; it alone writes `body`
//   degraded   — stream down, polling succeeding ("Live-ish")
//   offline    — stream down AND the last poll failed; the page stops
//                claiming liveness (the number may be stale)
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SALE_EVENTS_URL,
  fetchSaleStatus,
  parseSaleStatus,
  type SaleStatusBody,
} from "../api/sale.ts";

export type Channel = "connecting" | "live" | "degraded" | "offline";

/** Middle of the spine's 2–10 s fallback band. */
export const POLL_MS = 5_000;

export interface SaleStatusHandle {
  body: SaleStatusBody | null;
  channel: Channel;
  /** One-shot re-sync. Story 2.3 calls it after every order attempt (FR-5). */
  refetch: () => void;
}

export function useSaleStatus(): SaleStatusHandle {
  const [body, setBody] = useState<SaleStatusBody | null>(null);
  const [channel, setChannel] = useState<Channel>("connecting");

  const channelRef = useRef<Channel>("connecting");
  const mountedRef = useRef(true);
  const sourceRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    void fetchSaleStatus()
      .then((next) => {
        // A re-sync never changes the channel — it only pushes the freshest
        // body it just read. While live, the stream still wins from here on.
        if (mountedRef.current) {
          setBody(next);
        }
      })
      .catch(() => {
        // Silent: a re-sync failure is not a verdict, and the status zone
        // keeps whatever truth it has (AD-5 is not a page takeover).
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();

    const stopPolling = () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    const closeStream = () => {
      if (sourceRef.current !== null) {
        sourceRef.current.close();
        sourceRef.current = null;
      }
    };

    const openStream = () => {
      closeStream();
      const source = new EventSource(SALE_EVENTS_URL);
      sourceRef.current = source;

      source.onopen = () => {
        if (!mountedRef.current) {
          return;
        }
        // RECOVERY, not first connect: the server snapshots on every connect,
        // so a cold open needs nothing extra. It is the recovery case that must
        // not leave a frame from the outage on screen.
        const recovering = channelRef.current === "degraded" || channelRef.current === "offline";
        setChannelSafely("live");
        stopPolling();
        if (recovering) {
          // Re-sync ONCE. Belt to the snapshot's braces — correct even if the
          // snapshot frame is lost in flight.
          void fetchSaleStatus(controller.signal).then(writeFromStream).catch(() => {});
        }
      };

      // The server names its event `status` — a bare onmessage handler would
      // receive NOTHING (onmessage fires only for unnamed events).
      source.addEventListener("status", (event) => {
        let raw: unknown;
        try {
          raw = JSON.parse((event as MessageEvent<string>).data);
        } catch {
          return; // A malformed frame is ignored, never painted.
        }
        const next = parseSaleStatus(raw);
        if (next !== null) {
          writeFromStream(next);
        }
      });

      source.onerror = () => {
        // A 503 closes the stream for good — EventSource does NOT auto-reconnect.
        // The fallback loop below is the only reconnect mechanism there is.
        closeStream();
        if (!mountedRef.current) {
          return;
        }
        // Drop the liveness claim THE MOMENT the stream dies — before any poll
        // resolves. Leaving `live` set here would silently keep discarding
        // polls (the sole-writer guard) and strand the page on a frozen number
        // while insisting it was live.
        if (channelRef.current === "live") {
          setChannelSafely("degraded");
        }
        startFallback();
      };
    };

    /** `fromFallback` marks the polls that are *carrying* the page (the stream
     *  is known down). Only those may claim "degraded" or admit "offline" —
     *  the cold-load poll paints, but the stream's own outcome decides the
     *  channel, so the sticker never flashes a claim it hasn't earned. */
    const pollOnce = (fromFallback: boolean) => {
      void fetchSaleStatus(controller.signal)
        .then((next) => {
          if (!mountedRef.current || channelRef.current === "live") {
            return;
          }
          writeFromPoll(next);
          if (fromFallback) {
            setChannelSafely("degraded");
          }
        })
        .catch(() => {
          if (fromFallback && mountedRef.current && channelRef.current !== "live") {
            // Both channels unreachable: stop claiming liveness. `body` is
            // left untouched — stale-but-marked, or null on a cold load.
            setChannelSafely("offline");
          }
        });
    };

    function startFallback() {
      if (timerRef.current !== null) {
        return; // Exactly one timer, ever.
      }
      pollOnce(true);
      timerRef.current = setInterval(() => {
        pollOnce(true);
        openStream(); // Re-create the stream each cycle until it re-establishes.
      }, POLL_MS);
    }

    // Cold load: open the stream AND read the status, so the first paint is
    // whichever answers first. There is no skeleton — the first response IS
    // the loading end.
    openStream();
    pollOnce(false);

    return () => {
      mountedRef.current = false;
      controller.abort();
      stopPolling();
      closeStream();
    };
  }, [setChannelSafely, writeFromPoll, writeFromStream]);

  return { body, channel, refetch };
}
