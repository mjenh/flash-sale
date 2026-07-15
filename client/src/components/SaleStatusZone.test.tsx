import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SaleStatusBody, SaleState } from "../api/sale.ts";
import type { Channel } from "../hooks/useSaleStatus.ts";
import {
  COLD_LOAD_LINE,
  ENDED_FRAME,
  LIVE_NOTE,
  SOLD_OUT_FRAME,
  SaleStatusZone,
} from "./SaleStatusZone.tsx";
import { DEGRADED_LABEL, LIVE_LABEL } from "./LiveSticker.tsx";
import { LAST_SEEN_LINE } from "./StockNumeral.tsx";
import { localTime } from "./StatusChip.tsx";

afterEach(() => {
  cleanup();
});

// Far enough out that the countdown stays silent unless a test wants it.
const START = "2026-07-10T04:00:00.000Z";
const END = "2026-07-10T05:00:00.000Z";

function body(status: SaleState, stock = 37): SaleStatusBody {
  return { success: true, status, stock, startTime: START, endTime: END };
}

function paint(status: SaleState, channel: Channel = "live", stock = 37) {
  return render(<SaleStatusZone body={body(status, stock)} channel={channel} />);
}

describe("the four states, verbatim", () => {
  it("upcoming: the poster panel, the status string with viewer-local time — no numeral, no sticker", () => {
    paint("upcoming");

    expect(screen.getByTestId("status-chip")).toHaveTextContent(
      `Upcoming — sale starts at ${localTime(START)}`,
    );

    expect(screen.queryByTestId("stock-numeral")).toBeNull();
    expect(screen.queryByTestId("live-sticker")).toBeNull();
  });

  it("active: the live numeral, the exact chip, the sticker, and the stream's own promise", () => {
    paint("active", "live", 37);

    expect(screen.getByTestId("status-chip").textContent).toBe("Active — 37 units remaining");
    expect(screen.getByTestId("stock-numeral")).toHaveTextContent("37");
    expect(screen.getByTestId("stock-numeral")).toHaveTextContent("left");
    expect(screen.getByTestId("live-sticker").textContent).toBe(LIVE_LABEL);
    expect(screen.getByTestId("live-note").textContent).toBe(LIVE_NOTE);
  });

  it("sold_out: the numeral holds at 0, the chip flips, the sticker stays while the window is open", () => {
    paint("sold_out", "live", 0);

    expect(screen.getByTestId("status-chip").textContent).toBe("Sold Out");
    expect(screen.getByTestId("stock-numeral")).toHaveTextContent("0");
    expect(screen.getByTestId("stock-numeral").className).toContain("stock-numeral--drained");
    expect(screen.getByText(SOLD_OUT_FRAME)).toBeInTheDocument();
    expect(screen.getByTestId("live-sticker")).toBeInTheDocument();
    expect(screen.queryByTestId("countdown")).toBeNull();
  });

  it("ended: the wrap-up at headline scale in sentence case — no numeral, no countdown, no sticker", () => {
    paint("ended", "live", 0);

    expect(screen.getByTestId("status-chip").textContent).toBe("Sale Ended");
    expect(screen.getByTestId("ended-frame").textContent).toBe(ENDED_FRAME);
    expect(ENDED_FRAME).toBe("That one's a wrap.");

    expect(screen.queryByTestId("stock-numeral")).toBeNull();
    expect(screen.queryByTestId("countdown")).toBeNull();
    expect(screen.queryByTestId("live-sticker")).toBeNull();
  });
});

describe("channel honesty", () => {
  it("degraded: the sticker says so, and the stream's promise is withheld", () => {
    paint("active", "degraded");

    expect(screen.getByTestId("live-sticker").textContent).toBe(DEGRADED_LABEL);
    expect(DEGRADED_LABEL).toBe("Live-ish — checking every few seconds");
    expect(screen.queryByTestId("live-note")).toBeNull();
  });

  it("offline: no liveness claim at all, and the number is not presented as current", () => {
    paint("active", "offline");

    expect(screen.queryByTestId("live-sticker")).toBeNull();
    expect(screen.queryByTestId("live-note")).toBeNull();
    expect(screen.getByTestId("stock-numeral").className).toContain("stock-numeral--stale");
    expect(screen.getByText(LAST_SEEN_LINE)).toBeInTheDocument();
  });

  it("cold-load failure: the honest line, in plain text — never in a status chip", () => {
    render(<SaleStatusZone body={null} channel="offline" />);

    expect(screen.getByTestId("unreachable").textContent).toBe(COLD_LOAD_LINE);
    expect(COLD_LOAD_LINE).toBe("Can't reach the sale — retrying…");

    // Chips are reserved for verbatim API truth. There is none here.
    expect(screen.queryByTestId("status-chip")).toBeNull();
    expect(screen.queryByTestId("live-sticker")).toBeNull();
    expect(screen.queryByTestId("stock-numeral")).toBeNull();
  });

  it("cold load in flight: the poster furniture, no chip, no claim — and no skeleton", () => {
    const { container } = render(<SaleStatusZone body={null} channel="connecting" />);

    expect(screen.getByText("Doors open soon.")).toBeInTheDocument();
    expect(screen.queryByTestId("status-chip")).toBeNull();
    expect(container.querySelector("[aria-busy]")).toBeNull();
    expect(container.querySelector(".skeleton")).toBeNull();
  });
});

describe("accessibility floor", () => {
  it("announces the sale-state flip assertively with the verbatim string — and does not re-announce on a stock change", () => {
    const { rerender } = render(<SaleStatusZone body={body("active", 37)} channel="live" />);

    const flip = screen.getByTestId("flip-announcer");
    expect(flip).toHaveAttribute("aria-live", "assertive");
    expect(flip.textContent).toBe("Active — 37 units remaining");

    // Stock moves; the state does not. The assertive line must hold.
    rerender(<SaleStatusZone body={body("active", 36)} channel="live" />);
    expect(screen.getByTestId("flip-announcer").textContent).toBe("Active — 37 units remaining");

    // A real flip does announce.
    rerender(<SaleStatusZone body={body("sold_out", 0)} channel="live" />);
    expect(screen.getByTestId("flip-announcer").textContent).toBe("Sold Out");
  });

  it("announces the numeral politely and only on milestones — never per-decrement", () => {
    const { rerender } = render(<SaleStatusZone body={body("active", 37)} channel="live" />);

    const polite = screen.getByTestId("stock-announcer");
    expect(polite).toHaveAttribute("aria-live", "polite");
    expect(polite.textContent).toBe("37 left");

    rerender(<SaleStatusZone body={body("active", 36)} channel="live" />);
    expect(screen.getByTestId("stock-announcer").textContent).toBe("37 left"); // no firehose

    rerender(<SaleStatusZone body={body("active", 30)} channel="live" />);
    expect(screen.getByTestId("stock-announcer").textContent).toBe("30 left"); // milestone

    rerender(<SaleStatusZone body={body("active", 27)} channel="live" />);
    expect(screen.getByTestId("stock-announcer").textContent).toBe("30 left");

    rerender(<SaleStatusZone body={body("active", 3)} channel="live" />);
    expect(screen.getByTestId("stock-announcer").textContent).toBe("3 left"); // the last few
  });

  it("keeps the four states distinct WITHOUT COLOR — by string, composition, and sticker presence", () => {
    const fingerprints = new Set<string>();

    for (const [status, stock] of [
      ["upcoming", 100],
      ["active", 37],
      ["sold_out", 0],
      ["ended", 0],
    ] as [SaleState, number][]) {
      cleanup();
      paint(status, "live", stock);
      const chip = screen.queryByTestId("status-chip")?.textContent ?? "";
      const hasNumeral = screen.queryByTestId("stock-numeral") !== null;
      const hasSticker = screen.queryByTestId("live-sticker") !== null;
      fingerprints.add(`${chip}|numeral:${hasNumeral}|sticker:${hasSticker}`);
    }

    expect(fingerprints.size).toBe(4);
  });
});
