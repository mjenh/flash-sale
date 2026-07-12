// The personal answer to YOUR attempt — inline, never a modal, never a toast.
// The verbatim string sits in mono inside its chip; the warmth lives in the
// frame above it, never inside it.
//
// The panel takes focus when it lands. That focus move IS the announcement —
// it carries NO aria-live, because doing both double-announces.
import { useEffect, useRef } from "react";
import type { SaleState } from "../api/sale.ts";
import type { Verdict, VerdictKind } from "../api/order.ts";
import { Panel } from "./Panel.tsx";
import { ENDED_FRAME, SOLD_OUT_FRAME, UPCOMING_FRAME } from "./SaleStatusZone.tsx";
import "./VerdictPanel.css";

export const SUCCESS_FRAME = "It's yours!";
export const ALREADY_FRAME = "All set — your order from today is safe.";

/** The warm frame, or null when the string must stand alone (errors: honest,
 *  no blame, nothing dressed up). */
function frameFor(kind: VerdictKind, saleState: SaleState | null): string | null {
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
      return saleState === "upcoming" ? UPCOMING_FRAME : ENDED_FRAME;
    case "invalid":
    case "unavailable":
    case "network":
      return null;
  }
}

/** Accent + composition, never color alone (SM-5). */
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
}

export function VerdictPanel({ verdict, saleState }: VerdictPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const accent = accentFor(verdict.kind);
  const frame = frameFor(verdict.kind, saleState);

  useEffect(() => {
    ref.current?.focus();
  }, [verdict]);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      aria-label="Your order verdict"
      className="verdict-focus"
      data-testid="verdict-panel"
    >
      <Panel variant="cream" className={`verdict-panel verdict-panel--${accent}`}>
        {/* Success alone gets the slapped-on flag; it IS this verdict's frame,
            so the frame is never rendered twice. */}
        {verdict.kind === "success" ? (
          <span className="t-chip verdict-panel__flag" data-testid="verdict-flag">
            {SUCCESS_FRAME}
          </span>
        ) : frame === null ? null : (
          <p className="verdict-panel__frame" data-testid="verdict-frame">
            {frame}
          </p>
        )}

        <p className="t-mono verdict-panel__string" data-testid="verdict-string">
          {verdict.message}
        </p>
      </Panel>
    </div>
  );
}
