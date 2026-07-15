// The one renderer of the four sale states — the client's mirror of the
// server's sale-status service. Nothing else in the client derives a status
// string (StatusChip.statusString is the sole composer).
//
// Two axes, never conflated: the sale's state (upcoming/active/sold_out/ended)
// and the channel's honesty (live/degraded/offline). The four states are
// distinct by verbatim string, composition, and sticker presence — color is
// never the only signal.
import { useEffect, useRef, useState } from "react";
import type { SaleStatusBody } from "../api/sale.ts";
import type { Channel } from "../hooks/useSaleStatus.ts";
import { localTime } from "../utils/formatSaleTime.ts";
import { Panel } from "./Panel.tsx";
import { StatusChip, statusString } from "./StatusChip.tsx";
import { LiveSticker } from "./LiveSticker.tsx";
import { StockNumeral } from "./StockNumeral.tsx";
import { Countdown } from "./Countdown.tsx";
import "./SaleStatusZone.css";

export const COLD_LOAD_LINE = "Can't reach the sale — retrying…";
/** Static fallback for contexts that lack a startTime (e.g. VerdictPanel). */
export const UPCOMING_FRAME = "Almost time — the sale hasn't opened yet.";
/** Dynamic — returns a formatted copy string for the upcoming state. */
export function upcomingFrame(startTime: string): string {
  return `Almost time — doors open at ${localTime(startTime)}.`;
}
export const SOLD_OUT_FRAME = "Gone in seconds — every last one found a home.";
export const ENDED_FRAME = "That one's a wrap.";
export const LIVE_NOTE = "Grab one now!";

/** Milestones: every 10, then the last few. A 100 → 0 drain announces ~14
 *  times, not 100 — the screen reader is never firehosed. */
function milestoneOf(stock: number): number | null {
  if (stock <= 5) {
    return stock;
  }
  if (stock % 10 === 0) {
    return stock;
  }
  return null;
}

export interface SaleStatusZoneProps {
  body: SaleStatusBody | null;
  channel: Channel;
}

export function SaleStatusZone({ body, channel }: SaleStatusZoneProps) {
  // Assertive: the sale-state flip is the page's one critical event. A stock
  // decrement must NOT re-announce it.
  const [flipAnnouncement, setFlipAnnouncement] = useState("");
  const lastState = useRef<string | null>(null);

  // Polite + throttled: milestone summaries only.
  const [stockAnnouncement, setStockAnnouncement] = useState("");
  const lastMilestone = useRef<number | null>(null);

  useEffect(() => {
    if (body === null) {
      return;
    }
    if (lastState.current !== body.status) {
      lastState.current = body.status;
      setFlipAnnouncement(statusString(body));
      lastMilestone.current = null; // A fresh state re-arms the milestone line.
    }
  }, [body]);

  useEffect(() => {
    if (body === null || body.status !== "active") {
      return;
    }
    const milestone = lastMilestone.current === null ? body.stock : milestoneOf(body.stock);
    if (milestone !== null && milestone !== lastMilestone.current) {
      lastMilestone.current = milestone;
      setStockAnnouncement(`${milestone} left`);
    }
  }, [body]);

  const announcements = (
    <>
      <p className="visually-hidden" aria-live="assertive" data-testid="flip-announcer">
        {flipAnnouncement}
      </p>
      <p className="visually-hidden" aria-live="polite" data-testid="stock-announcer">
        {stockAnnouncement}
      </p>
    </>
  );

  // ── Cold load: nothing read yet. Not a skeleton — the poster furniture,
  //    carrying no chip and no claim. The first response IS the loading end.
  if (body === null) {
    return (
      <Panel variant="poster" className="stripes status-zone">
        {channel === "offline" ? (
          // Cold-load failure. Plain full-contrast text — NEVER a status chip,
          // because there is no verbatim truth to put in one.
          <p className="t-body status-zone__unreachable" data-testid="unreachable">
            {COLD_LOAD_LINE}
          </p>
        ) : (
          // No timing data yet — generic placeholder until the first response lands.
          <p className="t-headline status-zone__headline">Doors open soon.</p>
        )}
        {announcements}
      </Panel>
    );
  }

  if (body.status === "upcoming") {
    return (
      <Panel variant="poster" className="stripes status-zone">
        <p className="t-headline status-zone__headline">Doors at {localTime(body.startTime)}.</p>
        <StatusChip body={body} />
        <p className="t-body status-zone__frame">{upcomingFrame(body.startTime)}</p>
        <Countdown startTime={body.startTime} />
        {announcements}
      </Panel>
    );
  }

  if (body.status === "ended") {
    return (
      <Panel variant="poster" className="stripes status-zone">
        <StatusChip body={body} />
        <p className="status-zone__wrap" data-testid="ended-frame">
          {ENDED_FRAME}
        </p>
        {announcements}
      </Panel>
    );
  }

  // active | sold_out — the cream panel. The sticker stays while the window is
  // open, so sold_out keeps it.
  const drained = body.status === "sold_out";
  return (
    <Panel variant="cream" className="status-zone">
      <LiveSticker channel={channel} />
      <StockNumeral stock={body.stock} channel={channel} />
      <StatusChip body={body} />
      {drained ? (
        <p className="t-body status-zone__frame">{SOLD_OUT_FRAME}</p>
      ) : (
        // The promise belongs to the connected stream — withheld while degraded.
        channel === "live" && (
          <p className="t-meta status-zone__note" data-testid="live-note">
            {LIVE_NOTE}
          </p>
        )
      )}
      {announcements}
    </Panel>
  );
}
