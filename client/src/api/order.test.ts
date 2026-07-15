import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALREADY,
  checkOrder,
  checkOrderUrl,
  EMAIL_REQUIRED,
  INACTIVE,
  NETWORK,
  orderUrl,
  placeOrder,
  SOLD_OUT,
  SUCCESS,
  TIMEOUT_MS,
  UNAVAILABLE,
} from "./order.ts";

const SLUG = "flash-sale";

function replied(status: number, body: unknown) {
  return vi.fn(async () =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("URL builders (AC2 — every call is slug-scoped)", () => {
  it("orderUrl builds /api/sales/:slug/order", () => {
    expect(orderUrl(SLUG)).toBe("/api/sales/flash-sale/order");
  });

  it("checkOrderUrl builds /api/sales/:slug/order/:email, percent-encoded", () => {
    expect(checkOrderUrl(SLUG, "a+b@x.io")).toBe("/api/sales/flash-sale/order/a%2Bb%40x.io");
  });

  it("URL-encodes the slug", () => {
    expect(orderUrl("a slug/weird")).toBe("/api/sales/a%20slug%2Fweird/order");
  });
});

describe("placeOrder — the verbatim verdict for every wire outcome", () => {
  it("202 → success", async () => {
    vi.stubGlobal("fetch", replied(202, { success: true, email: "a@b.c", message: SUCCESS }));
    await expect(placeOrder(SLUG, "a@b.c")).resolves.toEqual({
      kind: "success",
      message: "Order successful.",
    });
  });

  it("200 → already ordered (idempotent retry outranks window and stock)", async () => {
    vi.stubGlobal("fetch", replied(200, { success: true, email: "a@b.c", message: ALREADY }));
    await expect(placeOrder(SLUG, "a@b.c")).resolves.toEqual({
      kind: "already",
      message: "You have already ordered this item.",
    });
  });

  it("409 tells its two rejections apart by the string itself", async () => {
    vi.stubGlobal("fetch", replied(409, { success: false, error: SOLD_OUT }));
    await expect(placeOrder(SLUG, "a@b.c")).resolves.toEqual({
      kind: "sold_out",
      message: "Item is sold out.",
    });

    vi.stubGlobal("fetch", replied(409, { success: false, error: INACTIVE }));
    await expect(placeOrder(SLUG, "a@b.c")).resolves.toEqual({
      kind: "inactive",
      message: "Sale is not active.",
    });
  });

  it("400 → the canonical validation string", async () => {
    vi.stubGlobal("fetch", replied(400, { success: false, error: EMAIL_REQUIRED }));
    await expect(placeOrder(SLUG, "")).resolves.toEqual({
      kind: "invalid",
      message: "Email is required.",
    });
  });

  it("503 → the fail-closed error verdict (a verdict, not a page takeover)", async () => {
    vi.stubGlobal("fetch", replied(503, { success: false, error: UNAVAILABLE }));
    await expect(placeOrder(SLUG, "a@b.c")).resolves.toEqual({
      kind: "unavailable",
      message: "Service temporarily unavailable.",
    });
  });

  it("a dropped connection → the network verdict; the string IS the message", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    await expect(placeOrder(SLUG, "a@b.c")).resolves.toEqual({
      kind: "network",
      message: "Something went wrong, please try again.",
    });
    expect(NETWORK).toBe("Something went wrong, please try again.");
  });

  it("renders the SERVER's wording, not a stale client constant", async () => {
    vi.stubGlobal("fetch", replied(409, { success: false, error: "Item is sold out, sorry." }));
    await expect(placeOrder(SLUG, "a@b.c")).resolves.toEqual({
      kind: "sold_out",
      message: "Item is sold out, sorry.",
    });
  });

  it("posts exactly { email } — never userId — to the slug-scoped URL", async () => {
    const fetchSpy = replied(202, { message: SUCCESS });
    vi.stubGlobal("fetch", fetchSpy);

    await placeOrder(SLUG, "  spaced@example.com  ".trim());

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(orderUrl(SLUG));
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ email: "spaced@example.com" });
    expect(String(init.body)).not.toContain("userId");
  });

  it("hits a different URL entirely for a different slug", async () => {
    const fetchSpy = replied(202, { message: SUCCESS });
    vi.stubGlobal("fetch", fetchSpy);

    await placeOrder("another-sale", "a@b.c");

    const [url] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/sales/another-sale/order");
  });
});

describe("placeOrder — the ~10s timeout", () => {
  it("aborts the request and answers with the network verdict", async () => {
    vi.useFakeTimers();

    let aborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
      ),
    );

    const pending = placeOrder(SLUG, "a@b.c");
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    await expect(pending).resolves.toEqual({ kind: "network", message: NETWORK });
    // Aborted for real — a hung socket must not hold a connection slot while
    // the buyer retries (retry is safe: the API is idempotent).
    expect(aborted).toBe(true);
  });
});

describe("checkOrder", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", replied(200, { success: true, ordered: true, email: "a+b@x.io" }));
  });

  it("reads the ordered flag and encodes the path segment", async () => {
    await expect(checkOrder(SLUG, "a+b@x.io")).resolves.toBe(true);
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/sales/flash-sale/order/a%2Bb%40x.io");
  });

  it("rejects on failure — the caller swallows it silently", async () => {
    vi.stubGlobal("fetch", replied(503, { success: false, error: UNAVAILABLE }));
    await expect(checkOrder(SLUG, "a@b.c")).rejects.toThrow();

    vi.stubGlobal("fetch", replied(200, { success: true }));
    await expect(checkOrder(SLUG, "a@b.c")).rejects.toThrow(/expected shape/);
  });
});
