// The hero: the server's exact number, the single largest thing on the page.
// No tweening, no easing, no optimistic decrement — the numeral is never ahead
// of or behind known truth. The server coalesces; the client just renders.
//
// At 0 it recolors to ink (sold_out). When the page cannot reach the sale, the
// number is NOT presented as current: it mutes and says so in full-contrast
// text beside itself. Hiding it would be its own kind of lie; showing it as
// live is the lie the spine forbids.
import type { Channel } from "../hooks/useSaleStatus.ts";
import "./StockNumeral.css";

export const LAST_SEEN_LINE = "Last seen — can't reach the sale right now.";

export interface StockNumeralProps {
  stock: number;
  channel: Channel;
}

export function StockNumeral({ stock, channel }: StockNumeralProps) {
  const stale = channel === "offline";
  const classes = [
    "stock-numeral",
    stock === 0 ? "stock-numeral--drained" : "",
    stale ? "stock-numeral--stale" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="stock-numeral-zone">
      <p className={classes} data-testid="stock-numeral" aria-hidden="true">
        <span className="t-numeral">{stock}</span>
        <span className="stock-numeral__unit">left</span>
      </p>
      {stale ? <p className="t-body stock-numeral__stale-note">{LAST_SEEN_LINE}</p> : null}
    </div>
  );
}
