import { afterEach, describe, expect, it, vi } from "vitest";
import { SALE_STATUS_URL, fetchSaleStatus, parseSaleStatus } from "./sale.ts";

const BODY = {
  success: true,
  status: "active",
  stock: 37,
  startTime: "2026-07-10T04:00:00.000Z",
  endTime: "2026-07-10T05:00:00.000Z",
};

function respond(body: unknown, status = 200) {
  return vi.fn(async () =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => Promise.resolve(body),
    } as Response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSaleStatus", () => {
  it("resolves the exact response body", async () => {
    const fetchSpy = respond(BODY);
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchSaleStatus()).resolves.toEqual(BODY);
    expect(fetchSpy).toHaveBeenCalledWith(SALE_STATUS_URL, { signal: undefined });
  });

  it("rejects the 503 fail-closed envelope rather than paint a fake state", async () => {
    vi.stubGlobal(
      "fetch",
      respond({ success: false, error: "Service temporarily unavailable." }, 503),
    );
    await expect(fetchSaleStatus()).rejects.toThrow(/503/);
  });

  it("rejects any non-2xx", async () => {
    vi.stubGlobal("fetch", respond(BODY, 500));
    await expect(fetchSaleStatus()).rejects.toThrow();
  });

  it("rejects a body it cannot prove", async () => {
    vi.stubGlobal("fetch", respond({ ...BODY, status: "on_fire" }));
    await expect(fetchSaleStatus()).rejects.toThrow(/expected shape/);
  });
});

describe("parseSaleStatus", () => {
  it("accepts each of the four states", () => {
    for (const status of ["upcoming", "active", "sold_out", "ended"]) {
      expect(parseSaleStatus({ ...BODY, status })?.status).toBe(status);
    }
  });

  it("refuses garbage: unknown status, non-numeric stock, missing times, non-objects", () => {
    expect(parseSaleStatus({ ...BODY, status: "paused" })).toBeNull();
    expect(parseSaleStatus({ ...BODY, stock: "37" })).toBeNull();
    expect(parseSaleStatus({ ...BODY, stock: Number.NaN })).toBeNull();
    expect(parseSaleStatus({ ...BODY, startTime: undefined })).toBeNull();
    expect(parseSaleStatus(null)).toBeNull();
    expect(parseSaleStatus("active")).toBeNull();
  });
});
