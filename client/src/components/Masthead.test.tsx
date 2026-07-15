import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { formatDateLine, Masthead } from "./Masthead.tsx";

afterEach(() => {
  cleanup();
});

const START = "2026-07-10T04:00:00Z";

/** The expectation is built from the same Intl contract the component promises,
 *  so the test is timezone-agnostic without pinning TZ. */
function expectedLine(iso: string): string {
  const d = new Date(iso);
  const day = d
    .toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
    .replace(/,/g, "");
  const doors = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} · doors ${doors}`;
}

describe("formatDateLine", () => {
  it("derives the date line from the server's ISO instant, viewer-local", () => {
    const line = formatDateLine(START);
    expect(line).toBe(expectedLine(START));
    expect(line).toMatch(/ · doors .+$/);
    // Never hand-maintained: the copy carries no hard-coded date.
    expect(line).not.toContain("undefined");
  });

  it("returns an empty line rather than fabricate a date from garbage", () => {
    expect(formatDateLine("not-a-date")).toBe("");
  });
});

describe("Masthead", () => {
  it("renders the brand line always and the date line only once the window is known", () => {
    const { rerender } = render(<Masthead />);
    expect(screen.getByText("Keycap·One presents")).toBeInTheDocument();
    expect(screen.getByTestId("masthead-date").textContent).toBe("");

    rerender(<Masthead startTime={START} />);
    expect(screen.getByTestId("masthead-date").textContent).toBe(expectedLine(START));
  });
});
