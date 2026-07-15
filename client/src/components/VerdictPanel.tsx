// The personal answer to YOUR attempt — now a modal pop-up over a dimmed
// backdrop. The verbatim string sits in mono inside its chip; the warmth lives
// in the frame above it, never inside it.
//
// The dialog takes focus when it lands, traps Tab within itself, and dismisses
// on the close button, Escape, or a backdrop click. As a role="dialog" with
// aria-modal, the platform announces it on open — so it carries NO aria-live.
import { useEffect, useRef } from "react";
import type { SaleState } from "../api/sale.ts";
import type { Verdict, VerdictKind } from "../api/order.ts";
import { Panel } from "./Panel.tsx";
import { ENDED_FRAME, SOLD_OUT_FRAME, UPCOMING_FRAME, upcomingFrame } from "./SaleStatusZone.tsx";
import "./VerdictPanel.css";

export const SUCCESS_FRAME = "It's yours!";
export const ALREADY_FRAME = "All set — your order from today is safe.";
export const CLOSE_LABEL = "Close";

/** The warm frame, or null when the string must stand alone (errors: honest,
 *  no blame, nothing dressed up). */
function frameFor(
  kind: VerdictKind,
  saleState: SaleState | null,
  startTime?: string,
): string | null {
  switch (kind) {
    case "success":
      return SUCCESS_FRAME;
    case "already":
      return ALREADY_FRAME;
    case "sold_out":
      return SOLD_OUT_FRAME;
    case "inactive":
      // The API sends ONE canonical string for both ends of the window. Only
      // the client knows which end you're at — so only the client can frame it.
      if (saleState === "upcoming") {
        return startTime ? upcomingFrame(startTime) : UPCOMING_FRAME;
      }
      return ENDED_FRAME;
    case "invalid":
    case "unavailable":
    case "network":
      return null;
  }
}

/** Accent and composition, never color alone. */
function accentFor(kind: VerdictKind): "success" | "reject" | "error" {
  switch (kind) {
    case "success":
    case "already":
      return "success";
    case "sold_out":
    case "inactive":
      return "reject";
    case "invalid":
    case "unavailable":
    case "network":
      return "error";
  }
}

export interface VerdictPanelProps {
  verdict: Verdict;
  saleState: SaleState | null;
  /** Dismiss the pop-up (close button, Escape, or backdrop click). */
  onClose: () => void;
  /** A submit-born verdict is the climax of the journey and takes focus. A
   *  zero-interaction load check must NOT yank focus out of the email field
   *  mid-typing — it is announced politely instead. */
  focusOnMount?: boolean;
  /** The snapshotted flash-sale price at the moment of purchase. Shown only on
   *  a success verdict — the immutable record of what the buyer paid. */
  purchasePrice?: number;
  /** ISO-8601 start time from the sale body — used to build the "upcoming"
   *  inactive-verdict frame so it shows the actual opening time, not "noon". */
  startTime?: string;
}

export function VerdictPanel({
  verdict,
  saleState,
  onClose,
  focusOnMount = true,
  purchasePrice,
  startTime,
}: VerdictPanelProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const accent = accentFor(verdict.kind);
  const frame = frameFor(verdict.kind, saleState, startTime);

  // Focus the dialog when it lands — but only when it answers an action the user
  // took. That focus move seats the keyboard inside the modal so the trap below
  // has somewhere to keep it.
  useEffect(() => {
    if (focusOnMount) {
      dialogRef.current?.focus();
    }
  }, [verdict, focusOnMount]);

  // Escape closes; Tab is trapped within the dialog so focus never escapes to
  // the dimmed page behind it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const root = dialogRef.current;
      if (root === null) {
        return;
      }
      const focusable = root.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="verdict-overlay"
      data-testid="verdict-overlay"
      // A click that starts AND ends on the backdrop dismisses. Clicks that
      // began inside the dialog (a drag that ended on the backdrop) do not.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label="Your order verdict"
        className="verdict-focus"
        data-testid="verdict-panel"
      >
        <Panel variant="cream" className={`verdict-panel verdict-panel--${accent}`}>
          <button
            type="button"
            className="verdict-panel__close pressable"
            aria-label={CLOSE_LABEL}
            data-testid="verdict-close"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>

          {/* A polite announcement stands in for the focus move a load-check
              deliberately declines to make. */}
          {focusOnMount ? null : (
            <p className="visually-hidden" aria-live="polite" data-testid="verdict-announce">
              {frame === null ? verdict.message : `${frame} ${verdict.message}`}
            </p>
          )}

          {/* Success alone gets the slapped-on flag; it IS this verdict's frame,
              so the frame is never rendered twice. Sentence-cased at
              headline-family scale — never CSS-uppercased at chip size. */}
          {verdict.kind === "success" ? (
            <span className="verdict-panel__flag" data-testid="verdict-flag">
              {SUCCESS_FRAME}
            </span>
          ) : frame === null ? null : (
            <p className="verdict-panel__frame" data-testid="verdict-frame">
              {frame}
            </p>
          )}

          {/* Immutable price receipt — only on success, only when the price is
              known. Shows the exact flash-sale price snapshotted at acceptance
              in orderlines.unitPrice — the historical record of what was paid. */}
          {verdict.kind === "success" && purchasePrice !== undefined && (
            <p className="verdict-panel__price" data-testid="verdict-price">
              Secured for{" "}
              <strong className="verdict-panel__price-amount">
                ${purchasePrice.toFixed(2)}
              </strong>
            </p>
          )}

          <p className="t-mono verdict-panel__string" data-testid="verdict-string">
            {verdict.message}
          </p>
        </Panel>
      </div>
    </div>
  );
}
