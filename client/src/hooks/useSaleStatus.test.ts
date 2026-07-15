import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEventSource, installFakeEventSource } from "../test/fake-event-source.ts";
import { POLL_MS, WATCHDOG_SILENCE_MS, useSaleStatus } from "./useSaleStatus.ts";
import { START_ISO, END_ISO } from "../test/time-fixtures.ts";

const SLUG = "flash-sale";

const BODY = {
  success: true as const,
  status: "active" as const,
  stock: 37,
  startTime: START_ISO,
  endTime: END_ISO,
};

function okOnce(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
}

function notFoundOnce() {
  return Promise.resolve({
    ok: false,
    status: 404,
    json: async () => ({ success: false, error: "Sale not found." }),
  } as Response);
}

function boom() {
  return Promise.reject(new Error("network down"));
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  installFakeEventSource();
  fetchSpy = vi.fn(() => okOnce(BODY));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useSaleStatus", () => {
  it("paints from the stream's named `status` frame and reports the channel live", async () => {
    const { result } = renderHook(() => useSaleStatus(SLUG));
    expect(result.current.channel).toBe("connecting");

    await act(async () => {
      FakeEventSource.current.open();
      FakeEventSource.current.emit(BODY);
    });

    expect(result.current.channel).toBe("live");
    expect(result.current.body).toEqual(BODY);
    expect(FakeEventSource.current.url).toBe(`/api/sales/${SLUG}/events`);
  });

  it("reads status from the slug-scoped URL (AC2)", async () => {
    renderHook(() => useSaleStatus(SLUG));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchSpy.mock.calls.some((c) => c[0] === `/api/sales/${SLUG}/status`)).toBe(true);
  });

  it("makes the open stream the SOLE WRITER — a poll that resolves while live is discarded", async () => {
    // The poll would say 99; the stream said 37. The stream wins.
    fetchSpy.mockImplementation(() => okOnce({ ...BODY, stock: 99 }));

    const { result } = renderHook(() => useSaleStatus(SLUG));

    await act(async () => {
      FakeEventSource.current.open();
      FakeEventSource.current.emit(BODY);
    });
    // Let the cold-load poll (fired on mount) settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.channel).toBe("live");
    expect(result.current.body?.stock).toBe(37);
  });

  it("ignores a malformed frame rather than paint it", async () => {
    const { result } = renderHook(() => useSaleStatus(SLUG));

    await act(async () => {
      FakeEventSource.current.open();
      FakeEventSource.current.emit(BODY);
      FakeEventSource.current.emit("{not json");
      FakeEventSource.current.emit({ ...BODY, status: "on_fire" });
    });

    expect(result.current.body).toEqual(BODY);
  });

  it("degrades to polling when the stream dies, and re-creates the stream each cycle", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSaleStatus(SLUG));

    await act(async () => {
      FakeEventSource.current.fail();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.channel).toBe("degraded");
    expect(result.current.body).toEqual(BODY);
    expect(FakeEventSource.current.closed).toBe(true);

    const before = FakeEventSource.instances.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    // A new EventSource per cycle — EventSource does NOT auto-reconnect after a 503.
    expect(FakeEventSource.instances.length).toBe(before + 1);
  });

  it("goes offline when both channels are down, keeping the last known body rather than erasing it", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSaleStatus(SLUG));

    await act(async () => {
      FakeEventSource.current.open();
      FakeEventSource.current.emit(BODY);
    });
    expect(result.current.body).toEqual(BODY);

    fetchSpy.mockImplementation(boom);
    await act(async () => {
      FakeEventSource.current.fail();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.channel).toBe("offline");
    // Stale, but marked — never erased, never presented as current.
    expect(result.current.body).toEqual(BODY);
  });

  it("on a cold-load failure stays offline with no body at all", async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation(boom);

    const { result } = renderHook(() => useSaleStatus(SLUG));
    await act(async () => {
      FakeEventSource.current.fail();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.channel).toBe("offline");
    expect(result.current.body).toBeNull();
  });

  it("re-syncs exactly once on stream recovery and stops polling", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSaleStatus(SLUG));

    await act(async () => {
      FakeEventSource.current.fail();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.channel).toBe("degraded");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    const callsBeforeRecovery = fetchSpy.mock.calls.length;
    await act(async () => {
      FakeEventSource.current.open(); // the re-created stream connects
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.channel).toBe("live");
    // Exactly one re-sync fetch on recovery…
    expect(fetchSpy.mock.calls.length).toBe(callsBeforeRecovery + 1);

    // …and the poll timer is gone: no further fetches, ever.
    const callsAfterRecovery = fetchSpy.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(fetchSpy.mock.calls.length).toBe(callsAfterRecovery);
  });

  it("tears down cleanly: the stream closes and the poll timer stops", async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useSaleStatus(SLUG));

    await act(async () => {
      FakeEventSource.current.fail();
      await vi.advanceTimersByTimeAsync(0);
    });

    const streams = FakeEventSource.instances.length;
    const calls = fetchSpy.mock.calls.length;
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    });

    expect(FakeEventSource.instances.every((s) => s.closed)).toBe(true);
    expect(FakeEventSource.instances.length).toBe(streams);
    expect(fetchSpy.mock.calls.length).toBe(calls);
  });

  it("refetch() obeys the sole-writer rule — while live it can NOT rewind the counter", async () => {
    // A re-sync GET and the SSE frame are independent Redis reads with no
    // ordering guarantee; a stale GET must never overwrite a newer frame,
    // rewinding the number or resurrecting `active` over `sold_out`.
    const { result } = renderHook(() => useSaleStatus(SLUG));

    await act(async () => {
      FakeEventSource.current.open();
      FakeEventSource.current.emit(BODY); // the stream said 37
    });

    fetchSpy.mockImplementation(() => okOnce({ ...BODY, stock: 12 }));
    await act(async () => {
      result.current.refetch();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The stream is the sole writer: the stale GET is discarded.
    expect(result.current.channel).toBe("live");
    expect(result.current.body?.stock).toBe(37);
  });

  it("refetch() DOES carry a fresh body while the stream is down", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSaleStatus(SLUG));

    await act(async () => {
      FakeEventSource.current.fail(); // fatal — stream down, now degraded
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.channel).toBe("degraded");

    fetchSpy.mockImplementation(() => okOnce({ ...BODY, stock: 12 }));
    await act(async () => {
      result.current.refetch();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.body?.stock).toBe(12);
    expect(result.current.channel).toBe("degraded");
  });

  it("keeps a quiet-but-live stream LIVE when heartbeats arrive (watchdog)", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSaleStatus(SLUG));

    await act(async () => {
      FakeEventSource.current.open();
      FakeEventSource.current.emit(BODY);
    });
    expect(result.current.channel).toBe("live");

    // No `status` frames for well past the watchdog window — but the named
    // heartbeat keeps arriving, so the stream must NOT be demoted as dead.
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WATCHDOG_SILENCE_MS / 2);
        FakeEventSource.current.heartbeat();
      });
    }

    expect(result.current.channel).toBe("live");
  });

  it("demotes a truly silent live stream once the watchdog window elapses", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSaleStatus(SLUG));

    await act(async () => {
      FakeEventSource.current.open();
      FakeEventSource.current.emit(BODY);
    });
    expect(result.current.channel).toBe("live");

    // No heartbeats, no frames: silence beyond the window is treated as death.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WATCHDOG_SILENCE_MS * 1.5);
    });

    expect(result.current.channel).not.toBe("live");
  });

  it("a recoverable mid-stream drop (error while CONNECTING) is left for the browser to retry", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSaleStatus(SLUG));

    await act(async () => {
      FakeEventSource.current.open();
      FakeEventSource.current.emit(BODY);
    });
    expect(result.current.channel).toBe("live");

    const stream = FakeEventSource.current;
    await act(async () => {
      stream.fail(FakeEventSource.CONNECTING); // browser is auto-reconnecting
      await vi.advanceTimersByTimeAsync(0);
    });

    // Liveness is dropped, the page falls back to polling — but the source is
    // NOT torn down, so the browser's native reconnect is left to do its job.
    expect(result.current.channel).toBe("degraded");
    expect(stream.closed).toBe(false);

    // When it re-establishes, the page returns to live.
    await act(async () => {
      stream.open();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.channel).toBe("live");
  });

  describe("notFound (AC3) — a slug that names no sale", () => {
    it("is set on a cold-load 404 and never becomes true otherwise", async () => {
      fetchSpy.mockImplementation(notFoundOnce);
      vi.useFakeTimers();

      const { result } = renderHook(() => useSaleStatus(SLUG));
      await act(async () => {
        FakeEventSource.current.fail();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(result.current.notFound).toBe(true);
    });

    it("is terminal — stops polling for good, no matter how much time passes", async () => {
      fetchSpy.mockImplementation(notFoundOnce);
      vi.useFakeTimers();

      const { result } = renderHook(() => useSaleStatus(SLUG));
      await act(async () => {
        FakeEventSource.current.fail();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.notFound).toBe(true);

      const callsAtNotFound = fetchSpy.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_MS * 5);
      });

      expect(fetchSpy.mock.calls.length).toBe(callsAtNotFound);
    });

    it("closes the stream and never reconnects once notFound is set", async () => {
      fetchSpy.mockImplementation(notFoundOnce);
      vi.useFakeTimers();

      renderHook(() => useSaleStatus(SLUG));
      await act(async () => {
        FakeEventSource.current.fail();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(FakeEventSource.current.closed).toBe(true);
      const streamsAtNotFound = FakeEventSource.instances.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_MS * 5);
      });

      expect(FakeEventSource.instances.length).toBe(streamsAtNotFound);
    });

    it("leaves a genuinely unreachable sale (non-404 failure) as offline, not notFound", async () => {
      fetchSpy.mockImplementation(boom);
      vi.useFakeTimers();

      const { result } = renderHook(() => useSaleStatus(SLUG));
      await act(async () => {
        FakeEventSource.current.fail();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(result.current.channel).toBe("offline");
      expect(result.current.notFound).toBe(false);
    });
  });
});
