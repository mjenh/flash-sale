// Unit tests for the sale resolution middleware — cache hit/miss/expiry,
// 404 on unknown slug, alias fallback to active sale, and the Express
// request augmentation. Tests call the middleware directly with fake
// req/res/next objects — no bootstrap, no Express app.

import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  createSaleResolver,
  isSaleActiveAt,
  type SaleLookupOps,
  type SaleSummary,
  selectActiveSale,
  windowFromSale,
} from "../src/middleware/sale-resolver.ts";
import { END_ISO, END_MS, START_ISO, START_MS } from "./helpers/time-fixtures.ts";

const FLASH_SALE: SaleSummary = {
  _id: "sale-1",
  slug: "flash-sale",
  startTime: new Date(START_MS),
  endTime: new Date(END_MS),
  stockQuantity: 100,
};

const SUMMER_SALE: SaleSummary = {
  _id: "sale-2",
  slug: "summer-sale",
  startTime: new Date(END_MS + 86_400_000),
  endTime: new Date(END_MS + 86_400_000 + 86_400_000),
  stockQuantity: 50,
};

const startMs = START_MS;
const endMs = END_MS;

function createFakeOps(
  sales: SaleSummary[] = [FLASH_SALE],
): SaleLookupOps & { calls: { findBySlug: number; findActiveSale: number } } {
  const calls = { findBySlug: 0, findActiveSale: 0 };
  return {
    calls,
    async findBySlug(slug: string): Promise<SaleSummary | null> {
      calls.findBySlug += 1;
      return sales.find((s) => s.slug === slug) ?? null;
    },
    async findActiveSale(nowMs: number): Promise<SaleSummary | null> {
      calls.findActiveSale += 1;
      // within window > nearest upcoming > most recently ended — this priority
      // is delegated to selectActiveSale() (reused rather than reimplemented,
      // so this fake stays in lockstep with the shared helper bootstrap.ts's
      // boot-time reconciliation also calls).
      return selectActiveSale(sales, nowMs);
    },
  };
}

function fakeReq(params: Record<string, string> = {}): Request {
  return { params, sale: undefined } as unknown as Request;
}

function fakeRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe("forSlug() middleware", () => {
  it("resolves a known slug and attaches req.sale", async () => {
    const ops = createFakeOps();
    const resolver = createSaleResolver({ ops, clock: () => startMs });
    const middleware = resolver.forSlug();

    const req = fakeReq({ slug: "flash-sale" });
    const res = fakeRes();
    const next = vi.fn();
    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.sale).toEqual(FLASH_SALE);
    expect(ops.calls.findBySlug).toBe(1);
  });

  it("returns 404 for an unknown slug and does not call next()", async () => {
    const ops = createFakeOps();
    const resolver = createSaleResolver({ ops, clock: () => startMs });
    const middleware = resolver.forSlug();

    const req = fakeReq({ slug: "nonexistent" });
    const res = fakeRes();
    const next = vi.fn();
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Sale not found." });
    expect(req.sale).toBeUndefined();
  });

  it("caches the result: second call within TTL does not query ops", async () => {
    const ops = createFakeOps();
    const resolver = createSaleResolver({ ops, clock: () => startMs, cacheTtlMs: 10_000 });
    const middleware = resolver.forSlug();

    // First call — cache miss.
    const req1 = fakeReq({ slug: "flash-sale" });
    await middleware(req1, fakeRes(), vi.fn());
    expect(ops.calls.findBySlug).toBe(1);

    // Second call — cache hit.
    const req2 = fakeReq({ slug: "flash-sale" });
    await middleware(req2, fakeRes(), vi.fn());
    expect(ops.calls.findBySlug).toBe(1); // not incremented
    expect(req2.sale).toEqual(FLASH_SALE);
  });

  it("cache expires: call after TTL queries ops again", async () => {
    let nowMs = startMs;
    const ops = createFakeOps();
    const resolver = createSaleResolver({ ops, clock: () => nowMs, cacheTtlMs: 5_000 });
    const middleware = resolver.forSlug();

    // First call — cache miss.
    await middleware(fakeReq({ slug: "flash-sale" }), fakeRes(), vi.fn());
    expect(ops.calls.findBySlug).toBe(1);

    // Advance past TTL.
    nowMs += 6_000;
    const req2 = fakeReq({ slug: "flash-sale" });
    await middleware(req2, fakeRes(), vi.fn());
    expect(ops.calls.findBySlug).toBe(2); // re-queried
    expect(req2.sale).toEqual(FLASH_SALE);
  });

  it("does not cache 404 results (miss on unknown slug is not cached)", async () => {
    const ops = createFakeOps();
    const resolver = createSaleResolver({ ops, clock: () => startMs });
    const middleware = resolver.forSlug();

    await middleware(fakeReq({ slug: "nope" }), fakeRes(), vi.fn());
    expect(ops.calls.findBySlug).toBe(1);

    // Second attempt — should query again (not cached).
    await middleware(fakeReq({ slug: "nope" }), fakeRes(), vi.fn());
    expect(ops.calls.findBySlug).toBe(2);
  });

  it("defaults to 60s TTL", async () => {
    let nowMs = startMs;
    const ops = createFakeOps();
    const resolver = createSaleResolver({ ops, clock: () => nowMs });
    const middleware = resolver.forSlug();

    await middleware(fakeReq({ slug: "flash-sale" }), fakeRes(), vi.fn());
    expect(ops.calls.findBySlug).toBe(1);

    // 59s later — still cached.
    nowMs += 59_000;
    await middleware(fakeReq({ slug: "flash-sale" }), fakeRes(), vi.fn());
    expect(ops.calls.findBySlug).toBe(1);

    // 61s later — expired.
    nowMs = startMs + 61_000;
    await middleware(fakeReq({ slug: "flash-sale" }), fakeRes(), vi.fn());
    expect(ops.calls.findBySlug).toBe(2);
  });
});

describe("findActive()", () => {
  it("returns the active sale for the discovery endpoint", async () => {
    const ops = createFakeOps([FLASH_SALE]);
    const resolver = createSaleResolver({ ops, clock: () => startMs + 1000 });

    const sale = await resolver.findActive();
    expect(sale).toEqual(FLASH_SALE);
  });

  it("returns null when no sales exist", async () => {
    const ops = createFakeOps([]);
    const resolver = createSaleResolver({ ops, clock: () => startMs });

    const sale = await resolver.findActive();
    expect(sale).toBeNull();
  });
});

describe("windowFromSale()", () => {
  it("converts a SaleSummary's Date fields into a SaleWindow of epoch ms + ISO strings", () => {
    expect(windowFromSale(FLASH_SALE)).toEqual({
      startMs: FLASH_SALE.startTime.getTime(),
      endMs: FLASH_SALE.endTime.getTime(),
      startIso: FLASH_SALE.startTime.toISOString(),
      endIso: FLASH_SALE.endTime.toISOString(),
    });
  });

  it("round-trips exactly for a sale resolved via forSlug()", async () => {
    const ops = createFakeOps();
    const resolver = createSaleResolver({ ops, clock: () => startMs });
    const req = fakeReq({ slug: "flash-sale" });
    await resolver.forSlug()(req, fakeRes(), vi.fn());

    const window = windowFromSale(req.sale as SaleSummary);
    expect(window.startMs).toBe(startMs);
    expect(window.endMs).toBe(endMs);
    expect(window.startIso).toBe(START_ISO);
    expect(window.endIso).toBe(END_ISO);
  });
});

describe("isSaleActiveAt()", () => {
  it("is true at the exact start instant and false at the exact end instant ([start, end) semantics)", () => {
    expect(isSaleActiveAt(FLASH_SALE, startMs)).toBe(true);
    expect(isSaleActiveAt(FLASH_SALE, endMs)).toBe(false);
    expect(isSaleActiveAt(FLASH_SALE, startMs - 1)).toBe(false);
    expect(isSaleActiveAt(FLASH_SALE, endMs - 1)).toBe(true);
  });
});

describe("selectActiveSale()", () => {
  it("returns the sale within its window when exactly one is active", () => {
    expect(selectActiveSale([FLASH_SALE, SUMMER_SALE], startMs + 1000)).toEqual(FLASH_SALE);
  });

  it("falls back to the nearest upcoming sale when none is within window", () => {
    expect(selectActiveSale([FLASH_SALE, SUMMER_SALE], startMs - 60_000)).toEqual(FLASH_SALE);
  });

  it("falls back to the most recently ended sale when none is active or upcoming", () => {
    expect(selectActiveSale([FLASH_SALE, SUMMER_SALE], SUMMER_SALE.endTime.getTime() + 60_000)).toEqual(
      SUMMER_SALE,
    );
  });

  it("returns null for an empty list", () => {
    expect(selectActiveSale([], startMs)).toBeNull();
  });

  it("boot-time overlap detection: two sales both within window at the same instant are BOTH found by a plain filter over isSaleActiveAt (the shared primitive bootstrap.ts's fail-fast check uses)", () => {
    const OVERLAP_A: SaleSummary = {
      _id: "sale-a",
      slug: "sale-a",
      startTime: new Date("2026-07-10T04:00:00Z"),
      endTime: new Date("2026-07-10T05:00:00Z"),
      stockQuantity: 10,
    };
    const OVERLAP_B: SaleSummary = {
      _id: "sale-b",
      slug: "sale-b",
      startTime: new Date("2026-07-10T04:15:00Z"),
      endTime: new Date("2026-07-10T05:15:00Z"),
      stockQuantity: 20,
    };
    const nowMs = Date.parse("2026-07-10T04:30:00Z");
    const active = [OVERLAP_A, OVERLAP_B].filter((s) => isSaleActiveAt(s, nowMs));
    expect(active).toHaveLength(2);
  });
});

describe("SaleSummary shape", () => {
  it("includes all required fields: _id, slug, startTime, endTime, stockQuantity", async () => {
    const ops = createFakeOps();
    const resolver = createSaleResolver({ ops, clock: () => startMs });
    const middleware = resolver.forSlug();

    const req = fakeReq({ slug: "flash-sale" });
    await middleware(req, fakeRes(), vi.fn());

    const sale = req.sale as SaleSummary;
    expect(sale._id).toBe("sale-1");
    expect(sale.slug).toBe("flash-sale");
    expect(sale.startTime).toBeInstanceOf(Date);
    expect(sale.endTime).toBeInstanceOf(Date);
    expect(typeof sale.stockQuantity).toBe("number");
  });
});
