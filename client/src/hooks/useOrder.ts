// The Buy Now flow. One request in flight, ever — first click wins — and the
// verdict replaces the beat. Post-verdict retries are allowed and un-scolded:
// the API is idempotent, so the worst a retry can do is tell you again
// that you already ordered.
//
// The empty-email check is the ONLY thing this hook refuses to send. There is
// no format gate — never block a plausible attempt client-side.
import { useCallback, useEffect, useRef, useState } from "react";
import { ALREADY, EMAIL_REQUIRED, checkOrder, placeOrder, type Verdict } from "../api/order.ts";

export type Phase = "idle" | "processing";

/** Where a verdict came from decides how it lands: a submit-born verdict is the
 *  climax of a keyboard journey and takes focus; a zero-interaction load check
 *  is a reassurance, announced politely and never yanking focus mid-typing. */
export type VerdictSource = "submit" | "check";

export interface OrderHandle {
  phase: Phase;
  verdict: Verdict | null;
  /** Provenance of the current verdict — null when there is none. */
  verdictSource: VerdictSource | null;
  /** Anchored at the input — never a verdict, never in the panel. */
  fieldError: string | null;
  submit: (email: string) => void;
  checkOnLoad: (email: string) => void;
  /** Clear the field error (e.g. as the buyer corrects the email). */
  clearFieldError: () => void;
  /** Dismiss the verdict pop-up. Clears the verdict so the modal closes. */
  clearVerdict: () => void;
}

export interface UseOrderOptions {
  /** Status re-fetches after every attempt — win, loss, or error alike. */
  onAttemptSettled?: () => void;
}

export function useOrder({ onAttemptSettled }: UseOrderOptions = {}): OrderHandle {
  const [phase, setPhase] = useState<Phase>("idle");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [verdictSource, setVerdictSource] = useState<VerdictSource | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // The in-flight guard is a ref, not the state value: two clicks in the same
  // tick would both read a stale `phase`.
  const inFlight = useRef(false);
  const checked = useRef(false);
  // Once the buyer submits, the load check is irrelevant — its late resolve must
  // never overwrite the answer to the attempt they actually made.
  const submitted = useRef(false);
  const checkAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    return () => {
      // A hung load-check must not resolve after unmount and pop a panel.
      mounted.current = false;
      checkAbort.current?.abort();
    };
  }, []);

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

      // From here on the load check is superseded: mark it, and abort it in
      // flight so it cannot land after the submit's own verdict.
      submitted.current = true;
      checkAbort.current?.abort();

      setFieldError(null);
      inFlight.current = true;
      setPhase("processing");

      void placeOrder(trimmed).then((next) => {
        inFlight.current = false;
        if (!mounted.current) {
          return;
        }
        if (next.kind === "invalid") {
          // An invalid attempt (e.g. a server 400) anchors at the field, not the
          // verdict panel — the panel is for outcomes, not input problems.
          setFieldError(next.message);
        } else {
          setVerdict(next);
          setVerdictSource("submit");
        }
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

    const controller = new AbortController();
    checkAbort.current = controller;

    void checkOrder(email.trim(), controller.signal)
      .then((ordered) => {
        // A submit already answered (or the hook is gone): the check is moot.
        if (!mounted.current || submitted.current) {
          return;
        }
        if (ordered) {
          // Relief in a single page-load — no interaction required.
          setVerdict({ kind: "already", message: ALREADY });
          setVerdictSource("check");
        }
      })
      .catch(() => {
        // Silent. No error verdict for a check the user never asked for.
      });
  }, []);

  const clearFieldError = useCallback(() => {
    setFieldError(null);
  }, []);

  const clearVerdict = useCallback(() => {
    setVerdict(null);
    setVerdictSource(null);
  }, []);

  return {
    phase,
    verdict,
    verdictSource,
    fieldError,
    submit,
    checkOnLoad,
    clearFieldError,
    clearVerdict,
  };
}
