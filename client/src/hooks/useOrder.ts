// The Buy Now flow. One request in flight, ever — first click wins — and the
// verdict replaces the beat. Post-verdict retries are allowed and un-scolded:
// the API is idempotent (FR-3), so the worst a retry can do is tell you again
// that you already ordered.
//
// The empty-email check is the ONLY thing this hook refuses to send. There is
// no format gate (SM-C1: never block a plausible attempt client-side).
import { useCallback, useRef, useState } from "react";
import { ALREADY, EMAIL_REQUIRED, checkOrder, placeOrder, type Verdict } from "../api/order.ts";

export type Phase = "idle" | "processing";

export interface OrderHandle {
  phase: Phase;
  verdict: Verdict | null;
  /** Anchored at the input — never a verdict, never in the panel. */
  fieldError: string | null;
  submit: (email: string) => void;
  checkOnLoad: (email: string) => void;
  /** Dismiss the verdict pop-up. Clears the verdict so the modal closes. */
  clearVerdict: () => void;
}

export interface UseOrderOptions {
  /** FR-5: status re-fetches after EVERY attempt — win, loss, or error alike. */
  onAttemptSettled?: () => void;
}

export function useOrder({ onAttemptSettled }: UseOrderOptions = {}): OrderHandle {
  const [phase, setPhase] = useState<Phase>("idle");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // The in-flight guard is a ref, not the state value: two clicks in the same
  // tick would both read a stale `phase`.
  const inFlight = useRef(false);
  const checked = useRef(false);

  const submit = useCallback(
    (email: string) => {
      const trimmed = email.trim();
      if (trimmed === "") {
        // Client-detected, identical to the canonical API 400 string.
        setFieldError(EMAIL_REQUIRED);
        return;
      }
      if (inFlight.current) {
        return; // First click wins. Not a debounce — a guard.
      }

      setFieldError(null);
      inFlight.current = true;
      setPhase("processing");

      void placeOrder(trimmed).then((next) => {
        inFlight.current = false;
        setVerdict(next);
        setPhase("idle");
        onAttemptSettled?.();
      });
    },
    [onAttemptSettled],
  );

  const checkOnLoad = useCallback((email: string) => {
    if (checked.current || email.trim() === "") {
      return;
    }
    checked.current = true;

    void checkOrder(email.trim())
      .then((ordered) => {
        if (ordered) {
          // Relief in a single page-load (UJ-2) — no interaction required.
          setVerdict({ kind: "already", message: ALREADY });
        }
      })
      .catch(() => {
        // Silent. No error verdict for a check the user never asked for.
      });
  }, []);

  const clearVerdict = useCallback(() => {
    setVerdict(null);
  }, []);

  return { phase, verdict, fieldError, submit, checkOnLoad, clearVerdict };
}
