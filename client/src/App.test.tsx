import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, PROCESSING_LINE, UPCOMING_BUTTON_REASON } from "./App.tsx";
import { HOUSE_RULES } from "./components/MarqueeBand.tsx";
import { ENDED_FRAME, SOLD_OUT_FRAME } from "./components/SaleStatusZone.tsx";
import { SUCCESS_FRAME } from "./components/VerdictPanel.tsx";
import type { SaleState } from "./api/sale.ts";
import { FakeEventSource, installFakeEventSource } from "./test/fake-event-source.ts";

const START = "2026-07-10T04:00:00.000Z";
const END = "2026-07-10T05:00:00.000Z";

function saleBody(status: SaleState, stock = 37) {
  return { success: true, status, stock, startTime: START, endTime: END };
}

function json(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

/** Routes by URL so a test can assert what the page asked for, and in what order. */
function router(handlers: {
  order?: () => Promise<Response>;
  check?: () => Promise<Response>;
  status?: () => Promise<Response>;
}) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.startsWith("/api/order")) {
      if (init?.method === "POST") {
        return handlers.order?.() ?? new Promise<Response>(() => {});
      }
      return handlers.check?.() ?? json(200, { success: true, ordered: false, email: "" });
    }
    return handlers.status?.() ?? json(200, saleBody("active"));
  });
}

let fetchSpy: ReturnType<typeof router>;

beforeEach(() => {
  installFakeEventSource();
  localStorage.clear();
  fetchSpy = router({});
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Paint the page from the stream, exactly as production does. */
async function paint(status: SaleState, stock = 37) {
  const view = render(<App />);
  await act(async () => {
    FakeEventSource.current.open();
    FakeEventSource.current.emit(saleBody(status, stock));
  });
  return view;
}

const buyNow = () => screen.getByRole("button", { name: /Buy Now/ });
const emailField = () => screen.getByLabelText("Who's buying?");

describe("the poster shell", () => {
  it("crawls the house rules aria-hidden, with the chips as its readable twin", async () => {
    const { container } = await paint("active");

    const band = container.querySelector(".marquee-band");
    expect(band).toHaveAttribute("aria-hidden", "true");
    expect(band?.textContent).toContain(HOUSE_RULES);
    expect(screen.getByRole("list", { name: "House rules" })).toBeInTheDocument();
  });

  it("holds the load-bearing negative space", async () => {
    const { container } = await paint("active");

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(container.querySelector("[aria-busy='true']")).toBeNull();
    expect(container.querySelector(".skeleton")).toBeNull();

    // The verdict panel is ABSENT until the first verdict.
    expect(screen.queryByTestId("verdict-panel")).toBeNull();

    // Exactly one action on the page.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});

describe("the living status zone, in the page", () => {
  it("paints on the first response — no skeleton in between", async () => {
    render(<App />);
    expect(screen.queryByTestId("status-chip")).toBeNull();
    expect(screen.getByText("Doors at noon.")).toBeInTheDocument();

    await act(async () => {
      FakeEventSource.current.open();
      FakeEventSource.current.emit(saleBody("active", 37));
    });

    expect(screen.getByTestId("status-chip").textContent).toBe("Active — 37 units remaining");
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

      if (status === "active") {
        expect(buyNow()).toBeEnabled();
        expect(screen.queryByTestId("buy-now-reason")).toBeNull();
      } else {
        expect(buyNow()).toBeDisabled();
        expect(screen.getByTestId("buy-now-reason").textContent).toBe(reason);
      }
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

  it("tells the truth when it cannot reach the sale, and FAILS OPEN so a status outage can't block a live sale (AI-S2-13)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("down"))));
    vi.useFakeTimers();

    render(<App />);
    await act(async () => {
      FakeEventSource.current.fail();
      await vi.advanceTimersByTimeAsync(0);
    });

    // The status zone stays honest: no machine-truth chip, no liveness claim,
    // just the retry line.
    expect(screen.getByTestId("unreachable").textContent).toBe("Can't reach the sale — retrying…");
    expect(screen.queryByTestId("status-chip")).toBeNull();

    // But Buy Now is ENABLED: the status path being down must not block a sale
    // the API would accept — the server's verdict decides the attempt (SM-C1).
    // A live button needs no dead-button reason.
    expect(buyNow()).not.toBeDisabled();
    expect(screen.queryByTestId("buy-now-reason")).toBeNull();
  });
});

describe("UJ-1 — the winner", () => {
  it("beats, then answers: processing acknowledgment → 'Order successful.' framed 'It's yours!', with focus", async () => {
    let release: (value: Response) => void = () => {};
    fetchSpy = router({
      order: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await paint("active", 37);

    fireEvent.change(emailField(), { target: { value: "priya@example.com" } });
    // A real click focuses the button; jsdom's fireEvent does not, so we focus
    // it first and then prove the beat does not TAKE the focus away (which a
    // `disabled` processing button would).
    buyNow().focus();
    fireEvent.click(buyNow());

    // The beat: the button yields, keeps focus, and says what it's doing.
    expect(screen.getByTestId("processing-line").textContent).toBe(PROCESSING_LINE);
    expect(PROCESSING_LINE).toBe("Hang tight — checking stock for you…");
    expect(buyNow()).toHaveAttribute("aria-busy", "true");
    expect(buyNow()).toHaveFocus();

    await act(async () => {
      release(await json(201, { success: true, email: "priya@example.com", message: "Order successful." }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("verdict-string").textContent).toBe("Order successful.");
    });
    expect(screen.getByTestId("verdict-flag").textContent).toBe(SUCCESS_FRAME);
    expect(screen.getByTestId("verdict-panel")).toHaveFocus();
    expect(screen.queryByTestId("processing-line")).toBeNull();
  });

  it("re-fetches the sale status after the attempt (FR-5)", async () => {
    fetchSpy = router({ order: () => json(201, { message: "Order successful." }) });
    vi.stubGlobal("fetch", fetchSpy);

    await paint("active", 37);
    const before = fetchSpy.mock.calls.filter((c) => c[0] === "/api/sale/status").length;

    fireEvent.change(emailField(), { target: { value: "priya@example.com" } });
    fireEvent.click(buyNow());

    await waitFor(() => {
      expect(screen.getByTestId("verdict-string")).toBeInTheDocument();
    });
    await waitFor(() => {
      const after = fetchSpy.mock.calls.filter((c) => c[0] === "/api/sale/status").length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("first click wins: mashing sends exactly one order", async () => {
    fetchSpy = router({ order: () => new Promise<Response>(() => {}) });
    vi.stubGlobal("fetch", fetchSpy);

    await paint("active", 37);
    fireEvent.change(emailField(), { target: { value: "dev@example.com" } });

    fireEvent.click(buyNow());
    fireEvent.click(buyNow());
    fireEvent.click(buyNow());

    const posts = fetchSpy.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(1);
  });
});

describe("UJ-4 — the fair loser", () => {
  it("gets the sympathetic frame; the field resets once the attempt is answered", async () => {
    fetchSpy = router({ order: () => json(409, { success: false, error: "Item is sold out." }) });
    vi.stubGlobal("fetch", fetchSpy);

    await paint("active", 1);
    fireEvent.change(emailField(), { target: { value: "dev@example.com" } });
    fireEvent.click(buyNow());

    await waitFor(() => {
      expect(screen.getByTestId("verdict-string").textContent).toBe("Item is sold out.");
    });
    expect(screen.getByTestId("verdict-frame").textContent).toBe(SOLD_OUT_FRAME);

    // The attempt is a completed action — the field resets (even on a rejection).
    await waitFor(() => {
      expect(emailField()).toHaveValue("");
    });
  });
});

describe("the email field is transient — never remembered", () => {
  it("starts empty on load, ignoring any stale persisted value (a refresh is a clean slate)", async () => {
    // Even if a previous build had persisted an address, the field no longer
    // reads it — a browser refresh always starts empty.
    localStorage.setItem("flash-sale:email", "tomas@example.com");

    await paint("active", 12);

    expect(emailField()).toHaveValue("");
  });

  it("makes no order-status check on load (nothing is remembered to check)", async () => {
    localStorage.setItem("flash-sale:email", "tomas@example.com");

    await paint("active", 12);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const checkedOnLoad = fetchSpy.mock.calls.some(
      (c) => typeof c[0] === "string" && c[0].startsWith("/api/order/"),
    );
    expect(checkedOnLoad).toBe(false);
    expect(screen.queryByTestId("verdict-panel")).toBeNull();
  });

  it("resets the field after a DEFINITIVE outcome (a completed attempt)", async () => {
    fetchSpy = router({ order: () => json(201, { message: "Order successful." }) });
    vi.stubGlobal("fetch", fetchSpy);

    await paint("active", 37);
    fireEvent.change(emailField(), { target: { value: "priya@example.com" } });
    expect(emailField()).toHaveValue("priya@example.com");

    fireEvent.click(buyNow());
    await waitFor(() => {
      expect(screen.getByTestId("verdict-string")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(emailField()).toHaveValue("");
    });
  });

  it("KEEPS the value on a recoverable error (503) so the buyer can retry without retyping", async () => {
    fetchSpy = router({
      order: () => json(503, { success: false, error: "Service temporarily unavailable." }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await paint("active", 37);
    fireEvent.change(emailField(), { target: { value: "priya@example.com" } });
    fireEvent.click(buyNow());

    await waitFor(() => {
      expect(screen.getByTestId("verdict-string").textContent).toBe(
        "Service temporarily unavailable.",
      );
    });

    // A transient failure is not the end of the attempt — the value stays put.
    expect(emailField()).toHaveValue("priya@example.com");
  });
});

describe("the identifier field accepts an email OR any other value", () => {
  it("submits a non-email identifier without a client-side format block", async () => {
    fetchSpy = router({ order: () => json(201, { message: "Order successful." }) });
    vi.stubGlobal("fetch", fetchSpy);

    await paint("active", 37);
    fireEvent.change(emailField(), { target: { value: "priya-the-collector" } });
    fireEvent.click(buyNow());

    await waitFor(() => {
      expect(screen.getByTestId("verdict-string")).toBeInTheDocument();
    });
    const post = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
      email: "priya-the-collector",
    });
  });

  it("tells the buyer both an email and any identifier are accepted, and is not an email-typed input", async () => {
    await paint("active", 37);

    expect(emailField()).not.toHaveAttribute("type", "email");
    expect(screen.getByText(/any identifier works/i)).toBeInTheDocument();
  });
});

describe("the honest edges", () => {
  it("empty submit: the error is anchored at the input, the verdict panel stays absent, nothing is sent", async () => {
    await paint("active", 37);

    fireEvent.click(buyNow());

    expect(screen.getByTestId("field-error").textContent).toContain("Email is required.");
    expect(emailField()).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByTestId("verdict-panel")).toBeNull();
    expect(
      fetchSpy.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST"),
    ).toHaveLength(0);
  });

  it("Enter from the field is the same submit path — and is inert while Buy Now is disabled", async () => {
    fetchSpy = router({ order: () => json(201, { message: "Order successful." }) });
    vi.stubGlobal("fetch", fetchSpy);

    // Upcoming: the button naps, so Enter does nothing.
    await paint("upcoming", 100);
    fireEvent.change(emailField(), { target: { value: "priya@example.com" } });
    fireEvent.submit(emailField());
    expect(
      fetchSpy.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST"),
    ).toHaveLength(0);

    // Active: the same Enter lands the same verdict a click would.
    await act(async () => {
      FakeEventSource.current.emit(saleBody("active", 37));
    });
    fireEvent.submit(emailField());

    await waitFor(() => {
      expect(screen.getByTestId("verdict-string").textContent).toBe("Order successful.");
    });
  });

  it("503: an honest error verdict — and Buy Now stays available for the retry", async () => {
    fetchSpy = router({
      order: () => json(503, { success: false, error: "Service temporarily unavailable." }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await paint("active", 37);
    fireEvent.change(emailField(), { target: { value: "priya@example.com" } });
    fireEvent.click(buyNow());

    await waitFor(() => {
      expect(screen.getByTestId("verdict-string").textContent).toBe(
        "Service temporarily unavailable.",
      );
    });
    expect(screen.queryByTestId("verdict-frame")).toBeNull(); // no blame, no dressing up
    expect(buyNow()).toBeEnabled();
  });
});
