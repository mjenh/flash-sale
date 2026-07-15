// Event identity. The date line is config-derived, never hand-maintained: it
// formats the sale window the server reports (`startTime`/`endTime` from the
// status body). Until the times are known there is no date line — the page
// never fabricates a date.
import "./Masthead.css";

export const BRAND_LINE = "Keycap·One presents";

/** "Wed Jul 15 · 8:00 PM to 11:00 PM" — viewer-local, from the server's ISO
 *  instants. Server-side UTC still governs all enforcement. */
export function formatDateLine(startIso: string, endIso?: string): string {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) {
    return "";
  }
  const day = start
    .toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
    .replace(/,/g, "");
  const startTime = start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (endIso) {
    const end = new Date(endIso);
    if (!Number.isNaN(end.getTime())) {
      const endTime = end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      return `${day} · ${startTime} to ${endTime}`;
    }
  }
  return `${day} · ${startTime}`;
}

export interface MastheadProps {
  /** ISO 8601 UTC instants from `/api/sales/:slug/status`. Absent until the first response. */
  startTime?: string;
  endTime?: string;
}

export function Masthead({ startTime, endTime }: MastheadProps) {
  const dateLine = startTime === undefined ? "" : formatDateLine(startTime, endTime);

  return (
    <header className="masthead">
      <span className="masthead__brand t-label">{BRAND_LINE}</span>
      <span className="masthead__date t-mono" data-testid="masthead-date">
        {dateLine}
      </span>
    </header>
  );
}
