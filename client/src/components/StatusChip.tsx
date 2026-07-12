// The machine-truth container. Every verbatim FR-5 status string lives here,
// in mono, never paraphrased — and NOTHING ELSE does. The cold-load line
// ("Can't reach the sale — retrying…") is not a verbatim API string, so it
// never enters a chip.
import type { SaleStatusBody } from "../api/sale.ts";
import "./StatusChip.css";

/** Viewer-local h:mm AM/PM. Server-side UTC still governs all enforcement. */
export function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** The ONLY place the four FR-5 strings are composed. */
export function statusString(body: SaleStatusBody): string {
  switch (body.status) {
    case "upcoming":
      return `Upcoming — sale starts at ${localTime(body.startTime)}`;
    case "active":
      return `Active — ${body.stock} units remaining`;
    case "sold_out":
      return "Sold Out";
    case "ended":
      return "Sale Ended";
  }
}

export function StatusChip({ body }: { body: SaleStatusBody }) {
  return (
    <p className="status-chip t-mono" data-testid="status-chip">
      {statusString(body)}
    </p>
  );
}
