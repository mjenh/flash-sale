import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrder } from "./useOrder.ts";

const SLUG = "flash-sale";

function replied(status: number, body: unknown) {
  return vi.fn(async () =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("submit", () => {
  it("refuses an empty email at the field and sends NOTHING", async () => {
    const fetchSpy = replied(201, { message: "Order successful." });
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useOrder({ slug: SLUG }));
    act(() => {
      result.current.submit("   ");
    });

    expect(result.current.fieldError).toBe("Email is required.");
    expect(result.current.verdict).toBeNull(); // never the verdict panel
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("has NO format gate — a plausible attempt is never blocked client-side", async () => {
    const fetchSpy = replied(201, { message: "Order successful." });
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useOrder({ slug: SLUG }));
    act(() => {
      result.current.submit("definitely-not-an-email");
    });

    await waitFor(() => {
      expect(result.current.verdict?.kind).toBe("success");
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.current.fieldError).toBeNull();
  });

  it("first click wins: a second submit while one is in flight is a no-op", async () => {
    let release: (value: Response) => void = () => {};
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useOrder({ slug: SLUG }));
    act(() => {
      result.current.submit("a@b.c");
      result.current.submit("a@b.c");
      result.current.submit("a@b.c");
    });

    expect(result.current.phase).toBe("processing");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({
        ok: true,
        status: 201,
        json: async () => ({ message: "Order successful." }),
      } as Response);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.phase).toBe("idle");
    });
    expect(result.current.verdict?.message).toBe("Order successful.");
  });

  it("re-fetches the sale status after EVERY attempt — win, loss, or error alike", async () => {
    const onAttemptSettled = vi.fn();

    for (const [status, body] of [
      [201, { message: "Order successful." }],
      [409, { error: "Item is sold out." }],
      [503, { error: "Service temporarily unavailable." }],
    ] as [number, unknown][]) {
      vi.stubGlobal("fetch", replied(status, body));
      const { result, unmount } = renderHook(() => useOrder({ slug: SLUG, onAttemptSettled }));
      act(() => {
        result.current.submit("a@b.c");
      });
      await waitFor(() => {
        expect(result.current.phase).toBe("idle");
      });
      unmount();
    }

    expect(onAttemptSettled).toHaveBeenCalledTimes(3);
  });

  it("lets a post-verdict retry replace the last verdict — un-scolded, idempotent", async () => {
    vi.stubGlobal("fetch", replied(409, { error: "Item is sold out." }));
    const { result } = renderHook(() => useOrder({ slug: SLUG }));

    act(() => {
      result.current.submit("a@b.c");
    });
    await waitFor(() => {
      expect(result.current.verdict?.kind).toBe("sold_out");
    });

    vi.stubGlobal("fetch", replied(200, { message: "You have already ordered this item." }));
    act(() => {
      result.current.submit("a@b.c");
    });
    await waitFor(() => {
      expect(result.current.verdict?.kind).toBe("already");
    });
    expect(result.current.verdict?.message).toBe("You have already ordered this item.");
  });

  it("posts to the slug-scoped order URL (AC2)", async () => {
    const fetchSpy = replied(201, { message: "Order successful." });
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useOrder({ slug: SLUG }));
    act(() => {
      result.current.submit("a@b.c");
    });

    await waitFor(() => {
      expect(result.current.verdict?.kind).toBe("success");
    });
    expect((fetchSpy.mock.calls[0] as unknown as [string])?.[0]).toBe(`/api/sales/${SLUG}/order`);
  });
});

describe("checkOnLoad — relief in a single page-load", () => {
  it("renders the reassurance verdict with no interaction when the email already holds an order", async () => {
    vi.stubGlobal("fetch", replied(200, { success: true, ordered: true, email: "a@b.c" }));

    const { result } = renderHook(() => useOrder({ slug: SLUG }));
    act(() => {
      result.current.checkOnLoad("a@b.c");
    });

    await waitFor(() => {
      expect(result.current.verdict).toEqual({
        kind: "already",
        message: "You have already ordered this item.",
      });
    });
    expect(result.current.phase).toBe("idle"); // the button stays live throughout
  });

  it("leaves the verdict zone absent when there is no order — and when there is no email", async () => {
    const fetchSpy = replied(200, { success: true, ordered: false, email: "a@b.c" });
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useOrder({ slug: SLUG }));
    act(() => {
      result.current.checkOnLoad("a@b.c");
    });
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    expect(result.current.verdict).toBeNull();

    const { result: blank } = renderHook(() => useOrder({ slug: SLUG }));
    act(() => {
      blank.current.checkOnLoad("");
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // no email, no check
  });

  it("fails silently — no error verdict for a check the user never asked for", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("down"))));

    const { result } = renderHook(() => useOrder({ slug: SLUG }));
    await act(async () => {
      result.current.checkOnLoad("a@b.c");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.verdict).toBeNull();
    expect(result.current.fieldError).toBeNull();
  });

  it("checks the slug-scoped order URL (AC2)", async () => {
    const fetchSpy = replied(200, { success: true, ordered: true, email: "a@b.c" });
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useOrder({ slug: SLUG }));
    act(() => {
      result.current.checkOnLoad("a@b.c");
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    expect((fetchSpy.mock.calls[0] as unknown as [string])?.[0]).toBe(`/api/sales/${SLUG}/order/a%40b.c`);
  });
});
