import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Countdown } from "./Countdown.tsx";

const NOW = new Date("2026-07-10T11:00:00.000Z").getTime();
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Countdown", () => {
  it("stays silent beyond the final hour — the verbatim status string carries alone", () => {
    render(<Countdown startTime={iso(3_600_001)} />);
    expect(screen.queryByTestId("countdown")).toBeNull();
  });

  it("ticks mm:ss inside the final hour", () => {
    render(<Countdown startTime={iso(599_000)} />);
    expect(screen.getByTestId("countdown").textContent).toBe("doors open in 09:59");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("countdown").textContent).toBe("doors open in 09:58");
  });

  it("PINS at 00:00 and flips nothing — the SSE `active` event is the only flip authority", () => {
    render(<Countdown startTime={iso(2000)} />);

    act(() => {
      vi.advanceTimersByTime(5000); // sail well past zero
    });

    expect(screen.getByTestId("countdown").textContent).toBe("doors open in 00:00");
    // By construction: the component takes no callback and returns no signal,
    // so the client clock cannot flip the page's state. Nothing to assert but
    // its own stubbornness.
    expect(screen.getByTestId("countdown")).toBeInTheDocument();
  });

  it("hides its digits from assistive tech and speaks at minute granularity", () => {
    render(<Countdown startTime={iso(125_000)} />);

    expect(screen.getByTestId("countdown")).toHaveAttribute("aria-hidden", "true");

    const polite = screen.getByText("3 minutes until doors open.");
    expect(polite).toHaveAttribute("aria-live", "polite");

    // A second passes: the digits move, the spoken line does not.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("countdown").textContent).toBe("doors open in 02:04");
    expect(screen.getByText("3 minutes until doors open.")).toBeInTheDocument();

    // A minute passes: now it speaks.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("2 minutes until doors open.")).toBeInTheDocument();
  });

  it("renders nothing for a start time it cannot parse", () => {
    render(<Countdown startTime="not-a-date" />);
    expect(screen.queryByTestId("countdown")).toBeNull();
  });
});
