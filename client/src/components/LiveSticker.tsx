// The sticker vouches for the CHANNEL, not the sale. It says exactly as much
// as the page can honestly claim:
//
//   live     → "Live — updates itself"
//   degraded → "Live-ish — checking every few seconds"
//   offline  → nothing at all. A page that cannot reach the sale does not get
//              to wear a liveness badge.
import type { Channel } from "../hooks/useSaleStatus.ts";
import "./LiveSticker.css";

export const LIVE_LABEL = "Live — updates itself";
export const DEGRADED_LABEL = "Live-ish — checking every few seconds";

export function LiveSticker({ channel }: { channel: Channel }) {
  if (channel !== "live" && channel !== "degraded") {
    return null;
  }

  return (
    <span className="live-sticker t-label" data-testid="live-sticker">
      <span className="live-sticker__blip" aria-hidden="true" />
      {channel === "live" ? LIVE_LABEL : DEGRADED_LABEL}
    </span>
  );
}
