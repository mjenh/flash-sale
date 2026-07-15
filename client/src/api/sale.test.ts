import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SaleNotFoundError,
  fetchSaleStatus,
  parseSaleStatus,
  saleEventsUrl,
  saleStatusUrl,
} from "./sale.ts";

const SLUG = "flash-sale";

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

describe("URL builders (AC2 — every call is slug-scoped)", () => {
  it("saleStatusUrl builds /api/sales/:slug/status", () => {
    expect(saleStatusUrl(SLUG)).toBe("/api/sales/flash-sale/status");
  });

  it("saleEventsUrl builds /api/sales/:slug/events", () => {
    expect(saleEventsUrl(SLUG)).toBe("/api/sales/flash-sale/events");
  });

  it("URL-encodes the slug", () => {
    expect(saleStatusUrl("a slug/weird")).toBe("/api/sales/a%20slug%2Fweird/status");
  });
});

describe("fetchSaleStatus", () => {
  it("resolves the exact response body", async () => {
    const fetchSpy = respond(BODY);
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchSaleStatus(SLUG)).resolves.toEqual(BODY);
    expect(fetchSpy).toHaveBeenCalledWith(saleStatusUrl(SLUG), { signal: undefined });
  });

  it("rejects the 503 fail-closed envelope rather than paint a fake state", async () => {
    vi.stubGlobal(
      "fetch",
      respond({ success: false, error: "Service temporarily unavailable." }, 503),
    );
    await expect(fetchSaleStatus(SLUG)).rejects.toThrow(/503/);
  });

  it("rejects any non-2xx (other than 404)", async () => {
    vi.stubGlobal("fetch", respond(BODY, 500));
    await expect(fetchSaleStatus(SLUG)).rejects.toThrow();
  });

  it("rejects a body it cannot prove", async () => {
    vi.stubGlobal("fetch", respond({ ...BODY, status: "on_fire" }));
    await expect(fetchSaleStatus(SLUG)).rejects.toThrow(/expected shape/);
  });

  it("rejects a 404 with the distinguished SaleNotFoundError (AC3)", async () => {
    vi.stubGlobal(
      "fetch",
      respond({ success: false, error: "Sale not found." }, 404),
    );
    await expect(fetchSaleStatus(SLUG)).rejects.toBeInstanceOf(SaleNotFoundError);
  });

  it("calls the slug-scoped URL, not the v1.0 implicit-sale path", async () => {
    const fetchSpy = respond(BODY);
    vi.stubGlobal("fetch", fetchSpy);

    await fetchSaleStatus(SLUG);
    const [url] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/sales/flash-sale/status");
    expect(url).not.toBe("/api/sale/status");
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
