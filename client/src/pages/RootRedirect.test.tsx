// The root `/` route — a defensive redirect using `GET /api/sales/active`.
// These tests pin the behavior: a successful discovery navigates to
// `/sale/${slug}`, and any failure (network error, 404, a malformed body)
// renders the "No active sale" fallback rather than hanging.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { NO_ACTIVE_SALE_MESSAGE, RootRedirect } from "./RootRedirect.tsx";
import { ACTIVE_SALE_URL } from "../hooks/useActiveSaleRedirect.ts";

function json(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

function renderAtRoot() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/sale/:slug" element={<div data-testid="landed">landed</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RootRedirect", () => {
  it("calls GET /api/sales/active and navigates to /sale/:slug on success", async () => {
    const fetchSpy = vi.fn(() => json(200, { success: true, slug: "flash-sale" }));
    vi.stubGlobal("fetch", fetchSpy);

    renderAtRoot();

    await waitFor(() => {
      expect(screen.getByTestId("landed")).toBeInTheDocument();
    });
    expect(fetchSpy).toHaveBeenCalledWith(ACTIVE_SALE_URL, expect.anything());
  });

  it("renders the friendly fallback on a 404 (no sales configured)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json(404, { success: false, error: "No sales configured." })),
    );

    renderAtRoot();

    await waitFor(() => {
      expect(screen.getByTestId("no-active-sale").textContent).toBe(NO_ACTIVE_SALE_MESSAGE);
    });
    expect(screen.queryByTestId("landed")).toBeNull();
  });

  it("renders the friendly fallback on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("down"))));

    renderAtRoot();

    await waitFor(() => {
      expect(screen.getByTestId("no-active-sale")).toBeInTheDocument();
    });
  });

  it("renders the friendly fallback on a malformed body (no honest slug to trust)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(200, { success: true })));

    renderAtRoot();

    await waitFor(() => {
      expect(screen.getByTestId("no-active-sale")).toBeInTheDocument();
    });
  });

  it("shows no flash of poster content while loading — just a polite status", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    renderAtRoot();

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByTestId("no-active-sale")).toBeNull();
    expect(screen.queryByTestId("landed")).toBeNull();
  });
});
