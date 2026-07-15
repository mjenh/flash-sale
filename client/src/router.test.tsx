// AC1 — proves the three routes are actually wired together, end to end,
// through the same route config (`routeObjects`) `main.tsx` feeds into
// `createBrowserRouter`. `createMemoryRouter` lets a test drive navigation
// without touching the real browser history.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { routeObjects } from "./router.tsx";
import { NOT_FOUND_HEADLINE } from "./pages/NotFoundPage.tsx";
import { SALE_NOT_FOUND_HEADLINE } from "./pages/SalePage.tsx";
import { NO_ACTIVE_SALE_MESSAGE } from "./pages/RootRedirect.tsx";
import { FakeEventSource, installFakeEventSource } from "./test/fake-event-source.ts";

const START = "2026-07-10T04:00:00.000Z";
const END = "2026-07-10T05:00:00.000Z";

function json(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

beforeEach(() => {
  installFakeEventSource();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the router (AC1)", () => {
  it("/sale/:slug renders the sale page for that slug", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        json(200, { success: true, status: "active", stock: 12, startTime: START, endTime: END }),
      ),
    );

    const router = createMemoryRouter(routeObjects, { initialEntries: ["/sale/flash-sale"] });
    render(<RouterProvider router={router} />);

    await act(async () => {
      FakeEventSource.current.open();
      FakeEventSource.current.emit({
        success: true,
        status: "active",
        stock: 12,
        startTime: START,
        endTime: END,
      });
    });

    expect(screen.getByRole("button", { name: /Buy Now/ })).toBeInTheDocument();
    expect(FakeEventSource.current.url).toBe("/api/sales/flash-sale/events");
  });

  it("/sale/:slug shows Sale not found for a 404 slug", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json(404, { success: false, error: "Sale not found." })),
    );

    const router = createMemoryRouter(routeObjects, { initialEntries: ["/sale/nope"] });
    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: SALE_NOT_FOUND_HEADLINE })).toBeInTheDocument();
    });
  });

  it("/ attempts the active-sale redirect and falls back gracefully when no active sale is found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json(404, { success: false, error: "No sales configured." })),
    );

    const router = createMemoryRouter(routeObjects, { initialEntries: ["/"] });
    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(screen.getByText(NO_ACTIVE_SALE_MESSAGE)).toBeInTheDocument();
    });
  });

  it("an unmatched path renders the generic 404", () => {
    const router = createMemoryRouter(routeObjects, { initialEntries: ["/this/goes/nowhere"] });
    render(<RouterProvider router={router} />);

    expect(screen.getByRole("heading", { name: NOT_FOUND_HEADLINE })).toBeInTheDocument();
  });
});
