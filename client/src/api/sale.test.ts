import { afterEach, describe, expect, it, vi } from "vitest";
import { END_ISO, START_ISO } from "../test/time-fixtures.ts";
import {
  fetchSaleDetails,
  fetchSaleStatus,
  parseSaleDetails,
  parseSaleStatus,
  SaleNotFoundError,
  saleDetailsUrl,
  saleEventsUrl,
  saleStatusUrl,
} from "./sale.ts";

const SLUG = "flash-sale";

const BODY = {
  success: true,
  status: "active",
  stock: 37,
  startTime: START_ISO,
  endTime: END_ISO,
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

  it("saleDetailsUrl builds /api/sales/:slug", () => {
    expect(saleDetailsUrl(SLUG)).toBe("/api/sales/flash-sale");
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

const DETAILS = {
  slug: SLUG,
  name: "Flash Sale",
  startTime: START_ISO,
  endTime: END_ISO,
  stockQuantity: 100,
  products: [{
    sku: "KC-001",
    name: "Keycap One",
    initialQuantity: 100,
    remaining: 42,
    originalPrice: 199.99,
    flashSalePrice: 99.99,
  }],
};

describe("fetchSaleDetails", () => {
  it("resolves the sale envelope's inner `sale` object", async () => {
    const fetchSpy = respond({ success: true, sale: DETAILS });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchSaleDetails(SLUG)).resolves.toEqual(DETAILS);
    expect(fetchSpy).toHaveBeenCalledWith(saleDetailsUrl(SLUG), { signal: undefined });
  });

  it("accepts a null `remaining` (Redis-down graceful degradation)", async () => {
    const withNullRemaining = {
      ...DETAILS,
      products: [{ ...DETAILS.products[0], remaining: null }],
    };
    vi.stubGlobal("fetch", respond({ success: true, sale: withNullRemaining }));
    await expect(fetchSaleDetails(SLUG)).resolves.toEqual(withNullRemaining);
  });

  it("rejects a 404 with the distinguished SaleNotFoundError", async () => {
    vi.stubGlobal("fetch", respond({ success: false, error: "Sale not found." }, 404));
    await expect(fetchSaleDetails(SLUG)).rejects.toBeInstanceOf(SaleNotFoundError);
  });

  it("rejects any non-2xx (other than 404)", async () => {
    vi.stubGlobal("fetch", respond({ success: true, sale: DETAILS }, 500));
    await expect(fetchSaleDetails(SLUG)).rejects.toThrow();
  });

  it("rejects a body it cannot prove", async () => {
    vi.stubGlobal("fetch", respond({ success: true, sale: { ...DETAILS, stockQuantity: "100" } }));
    await expect(fetchSaleDetails(SLUG)).rejects.toThrow(/expected shape/);
  });

  it("calls the slug-scoped URL", async () => {
    const fetchSpy = respond({ success: true, sale: DETAILS });
    vi.stubGlobal("fetch", fetchSpy);

    await fetchSaleDetails(SLUG);
    const [url] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/sales/flash-sale");
  });
});

describe("parseSaleDetails", () => {
  it("accepts a well-formed sale with products", () => {
    expect(parseSaleDetails(DETAILS)).toEqual(DETAILS);
  });

  it("accepts an empty products array", () => {
    expect(parseSaleDetails({ ...DETAILS, products: [] })).toEqual({ ...DETAILS, products: [] });
  });

  it("refuses garbage: non-object, missing fields, bad product shape, negative/fractional quantities", () => {
    expect(parseSaleDetails(null)).toBeNull();
    expect(parseSaleDetails("flash-sale")).toBeNull();
    expect(parseSaleDetails({ ...DETAILS, startTime: undefined })).toBeNull();
    expect(parseSaleDetails({ ...DETAILS, products: "not-an-array" })).toBeNull();
    expect(
      parseSaleDetails({ ...DETAILS, products: [{ ...DETAILS.products[0], initialQuantity: -1 }] }),
    ).toBeNull();
    expect(
      parseSaleDetails({ ...DETAILS, products: [{ ...DETAILS.products[0], remaining: 1.5 }] }),
    ).toBeNull();
    expect(
      parseSaleDetails({ ...DETAILS, products: [{ ...DETAILS.products[0], sku: undefined }] }),
    ).toBeNull();
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
