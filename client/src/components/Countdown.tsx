// The countdown is theatre, and it is built so it cannot be anything else: it
// takes no callback and returns no signal, so the client clock has NO flip
// authority (AD-6). At 00:00 it pins and the page HOLDS until the server's
// `active` event arrives.
//
// It appears only inside the final hour; beyond that the verbatim status string
// carries alone. Digits are aria-hidden — a per-second firehose helps nobody —
// and the accessible value updates at minute granularity.
import { useEffect, useRef, useState } from "react";
import "./Countdown.css";

const HOUR_MS = 3_600_000;

function remainingMs(startTime: string, now: number): number {
  const start = new Date(startTime).getTime();
  if (Number.isNaN(start)) {
    return Number.NaN;
  }
  return Math.max(0, start - now);
}

function mmss(ms: number): string {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function minuteLine(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 0) {
    return "Doors open any moment now.";
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} until doors open.`;
}

export function Countdown({ startTime }: { startTime: string }) {
  const [now, setNow] = useState(() => Date.now());
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    tick.current = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      if (tick.current !== null) {
        clearInterval(tick.current);
        tick.current = null;
      }
    };
  }, []);

  const left = remainingMs(startTime, now);
  if (Number.isNaN(left) || left > HOUR_MS) {
    // Beyond the final hour the static verbatim string carries alone.
    return null;
  }

  return (
    <>
      <p className="countdown t-mono" data-testid="countdown" aria-hidden="true">
        doors open in {mmss(left)}
      </p>
      <p className="visually-hidden" aria-live="polite">
        {minuteLine(left)}
      </p>
    </>
  );
}
