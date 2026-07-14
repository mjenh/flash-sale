// Unit tests for the sale resolution middleware — cache hit/miss/expiry,
// 404 on unknown slug, alias fallback to active sale, and the Express
// request augmentation. Tests call the middleware directly with fake
// req/res/next objects — no bootstrap, no Express app.
import { describe, expect, it, vi } from "vitest";
import {
  createSaleResolver,
  windowFromSale,
  type SaleLookupOps,
  type SaleSummary,
} from "../src/middleware/sale-resolver.ts";
import type { Request, Response, NextFunction } from "express";

const FLASH_SALE: SaleSummary = {
  _id: "sale-1",
  slug: "flash-sale",
  startTime: new Date("2026-07-10T04:00:00Z"),
  endTime: new Date("2026-07-10T05:00:00Z"),
  stockQuantity: 100,
};

const SUMMER_SALE: SaleSummary = {
  _id: "sale-2",
  slug: "summer-sale",
  startTime: new Date("2026-08-01T00:00:00Z"),
  endTime: new Date("2026-08-02T00:00:00Z"),
  stockQuantity: 50,
};

const startMs = FLASH_SALE.startTime.getTime();
const endMs = FLASH_SALE.endTime.getTime();

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
      // within window > nearest upcoming > most recently ended
      const active = sales.find(
        (s) => s.startTime.getTime() <= nowMs && nowMs < s.endTime.getTime(),
      );
      if (active !== undefined) {
        return active;
      }
      const upcoming = sales
        .filter((s) => s.startTime.getTime() > nowMs)
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
      if (upcoming.length > 0) {
        return upcoming[0] as SaleSummary;
      }
      const ended = sales
        .filter((s) => s.endTime.getTime() <= nowMs)
        .sort((a, b) => b.endTime.getTime() - a.endTime.getTime());
      return (ended[0] as SaleSummary | undefined) ?? null;
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

describe("forActiveSale() middleware", () => {
  it("resolves the active sale (within window) and attaches req.sale", async () => {
    const ops = createFakeOps([FLASH_SALE, SUMMER_SALE]);
    const resolver = createSaleResolver({ ops, clock: () => startMs + 1000 });
    const middleware = resolver.forActiveSale();

    const req = fakeReq();
    const next = vi.fn();
    await middleware(req, fakeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.sale).toEqual(FLASH_SALE);
  });

  it("falls back to nearest upcoming when no sale is within window", async () => {
    const ops = createFakeOps([FLASH_SALE, SUMMER_SALE]);
    // Before both sales.
    const resolver = createSaleResolver({
      ops,
      clock: () => FLASH_SALE.startTime.getTime() - 60_000,
    });
    const middleware = resolver.forActiveSale();

    const req = fakeReq();
    await middleware(req, fakeRes(), vi.fn());

    expect(req.sale).toEqual(FLASH_SALE);
  });

  it("falls back to most recently ended when no active or upcoming", async () => {
    const ops = createFakeOps([FLASH_SALE, SUMMER_SALE]);
    // After both sales.
    const resolver = createSaleResolver({
      ops,
      clock: () => SUMMER_SALE.endTime.getTime() + 60_000,
    });
    const middleware = resolver.forActiveSale();

    const req = fakeReq();
    await middleware(req, fakeRes(), vi.fn());

    expect(req.sale).toEqual(SUMMER_SALE); // most recently ended
  });

  it("always calls next() even when no sale is found", async () => {
    const ops = createFakeOps([]);
    const resolver = createSaleResolver({ ops, clock: () => startMs });
    const middleware = resolver.forActiveSale();

    const req = fakeReq();
    const next = vi.fn();
    await middleware(req, fakeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.sale).toBeUndefined();
  });

  it("caches the active sale lookup", async () => {
    const ops = createFakeOps([FLASH_SALE]);
    const resolver = createSaleResolver({ ops, clock: () => startMs + 1000, cacheTtlMs: 10_000 });
    const middleware = resolver.forActiveSale();

    await middleware(fakeReq(), fakeRes(), vi.fn());
    expect(ops.calls.findActiveSale).toBe(1);

    await middleware(fakeReq(), fakeRes(), vi.fn());
    expect(ops.calls.findActiveSale).toBe(1); // cached
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

describe("windowFromSale() (Story 4.4)", () => {
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
    expect(window.startIso).toBe("2026-07-10T04:00:00.000Z");
    expect(window.endIso).toBe("2026-07-10T05:00:00.000Z");
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
