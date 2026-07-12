import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, UPCOMING_BUTTON_REASON } from "./App.tsx";
import { HOUSE_RULES } from "./components/MarqueeBand.tsx";
import { ENDED_FRAME, SOLD_OUT_FRAME } from "./components/SaleStatusZone.tsx";
import type { SaleState } from "./api/sale.ts";
import { FakeEventSource, installFakeEventSource } from "./test/fake-event-source.ts";

const START = "2026-07-10T04:00:00.000Z";
const END = "2026-07-10T05:00:00.000Z";

function body(status: SaleState, stock = 37) {
  return { success: true, status, stock, startTime: START, endTime: END };
}

beforeEach(() => {
  installFakeEventSource();
  // The status fetch hangs by default: the shell must be honest before any
  // answer arrives, and the SSE snapshot is what normally paints first.
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Paint the page from the stream, exactly as production does. */
async function paint(status: SaleState, stock = 37) {
  const view = render(<App />);
  await act(async () => {
    FakeEventSource.current.open();
    FakeEventSource.current.emit(body(status, stock));
  });
  return view;
}

describe("Noon Poster shell", () => {
  it("crawls the house rules and nothing else — aria-hidden, with the chips as its readable twin", async () => {
    const { container } = await paint("active");

    const band = container.querySelector(".marquee-band");
    expect(band).toHaveAttribute("aria-hidden", "true");
    expect(band?.textContent).toContain(HOUSE_RULES);
    expect(HOUSE_RULES).toBe(
      "one each · fair and square · no carts · no queue-jumping · server clock rules",
    );

    expect(screen.getByRole("list", { name: "House rules" })).toBeInTheDocument();
    for (const rule of ["One each", "First come", "Straight answer"]) {
      expect(screen.getByText(rule)).toBeInTheDocument();
    }
  });

  it("renders the poster furniture and the config-derived date line once the server reports the window", async () => {
    const { container } = await paint("active");

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("The Noon Drop");
    expect(screen.getByText(/One limited-run mechanical keyboard/)).toBeInTheDocument();
    expect(container.querySelector(".product-tile")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("masthead-date").textContent).not.toBe("");
  });

  it("holds the load-bearing negative space", async () => {
    const { container } = await paint("active");

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(container.querySelector(".verdict-panel")).toBeNull();
    expect(container.querySelector("[aria-busy]")).toBeNull();
    expect(container.querySelector(".skeleton")).toBeNull();

    // Exactly one action on the page.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});

describe("the living status zone, in the page", () => {
  it("paints on the first response — there is no skeleton in between", async () => {
    render(<App />);

    // Before any answer: the poster furniture, no chip, no claim, no skeleton.
    expect(screen.queryByTestId("status-chip")).toBeNull();
    expect(screen.getByText("Doors at noon.")).toBeInTheDocument();

    await act(async () => {
      FakeEventSource.current.open();
      FakeEventSource.current.emit(body("active", 37));
    });

    expect(screen.getByTestId("status-chip").textContent).toBe("Active — 37 units remaining");
    expect(screen.getByTestId("stock-numeral")).toHaveTextContent("37");
  });

  it("drains the numeral live as frames arrive — the server's exact number, never tweened", async () => {
    await paint("active", 37);

    await act(async () => {
      FakeEventSource.current.emit(body("active", 36));
    });
    expect(screen.getByTestId("stock-numeral")).toHaveTextContent("36");

    await act(async () => {
      FakeEventSource.current.emit(body("sold_out", 0));
    });
    expect(screen.getByTestId("status-chip").textContent).toBe("Sold Out");
  });

  it("keeps the four states distinct without color, and enables Buy Now only in active (SM-5)", async () => {
    const seen = new Set<string>();

    for (const [status, stock, reason] of [
      ["upcoming", 100, UPCOMING_BUTTON_REASON],
      ["active", 37, null],
      ["sold_out", 0, SOLD_OUT_FRAME],
      ["ended", 0, ENDED_FRAME],
    ] as [SaleState, number, string | null][]) {
      cleanup();
      installFakeEventSource();
      await paint(status, stock);

      const buyNow = screen.getByRole("button", { name: "Buy Now" });
      if (status === "active") {
        expect(buyNow).toBeEnabled();
        expect(screen.queryByTestId("buy-now-reason")).toBeNull();
      } else {
        // A dead button says why it's dead, in full-contrast text beside it.
        expect(buyNow).toBeDisabled();
        expect(screen.getByTestId("buy-now-reason").textContent).toBe(reason);
      }

      // "Not yet" is the upcoming-only tag.
      expect(screen.queryByText("Not yet") !== null).toBe(status === "upcoming");

      seen.add(
        [
          screen.getByTestId("status-chip").textContent,
          screen.queryByTestId("stock-numeral") !== null,
          screen.queryByTestId("live-sticker") !== null,
        ].join("|"),
      );
    }

    expect(seen.size).toBe(4);
  });

  it("tells the truth when it cannot reach the sale: no chip, no claim, Buy Now disabled with the reason", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("down"))));
    vi.useFakeTimers();

    render(<App />);
    await act(async () => {
      FakeEventSource.current.fail();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByTestId("unreachable").textContent).toBe("Can't reach the sale — retrying…");
    expect(screen.queryByTestId("status-chip")).toBeNull();
    expect(screen.queryByTestId("live-sticker")).toBeNull();

    const buyNow = screen.getByRole("button", { name: "Buy Now" });
    expect(buyNow).toBeDisabled();
    expect(screen.getByTestId("buy-now-reason").textContent).toBe("Can't reach the sale — retrying…");

    vi.useRealTimers();
  });
});
