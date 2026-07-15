// The machine-truth container. Every verbatim status string lives here, in
// mono, never paraphrased — and nothing else does. The cold-load line
// ("Can't reach the sale — retrying...") is not a verbatim API string, so it
// never enters a chip.
import type { SaleStatusBody } from "../api/sale.ts";
import { localTime } from "../utils/formatSaleTime.ts";
import "./StatusChip.css";

/** The sole composer of the four status strings. */
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
