// Event identity. The date line is config-derived, never hand-maintained: it
// formats the sale window the server reports (`startTime` from the status
// body). Until the times are known there is no date line — the page never
// fabricates a date.
import "./Masthead.css";

export const BRAND_LINE = "Keycap·One presents";

/** "Fri Jul 10 · doors 12:00 PM" — viewer-local, from the server's ISO
 *  instant. Server-side UTC still governs all enforcement. */
export function formatDateLine(startIso: string): string {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) {
    return "";
  }
  const day = start
    .toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
    .replace(/,/g, "");
  const doors = start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} · doors ${doors}`;
}

export interface MastheadProps {
  /** ISO 8601 UTC instant from `/api/sales/:slug/status`. Absent until the first response. */
  startTime?: string;
}

export function Masthead({ startTime }: MastheadProps) {
  const dateLine = startTime === undefined ? "" : formatDateLine(startTime);

  return (
    <header className="masthead">
      <span className="masthead__brand t-label">{BRAND_LINE}</span>
      <span className="masthead__date t-mono" data-testid="masthead-date">
        {dateLine}
      </span>
    </header>
  );
}
