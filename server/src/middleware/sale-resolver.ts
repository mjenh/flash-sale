// Sale resolution middleware — resolves :slug to a Sale document and attaches
// it to req.sale. In-memory cache with configurable TTL (default 60s).
// Active-sale resolution for v1.0 aliases follows the priority: within
// [startTime, endTime) window > nearest upcoming > most recently ended.
//
// This middleware lives at the HTTP layer (it imports from express); the
// lookup ops port is satisfied by the adapter layer and injected at boot.
import type { Request, Response, NextFunction } from "express";
import type { Clock } from "../services/clock.ts";
import type { SaleWindow } from "../services/sale-status.ts";

/** The subset of a Sale document that downstream handlers read from req.sale. */
export interface SaleSummary {
  _id: string;
  slug: string;
  name?: string;
  startTime: Date;
  endTime: Date;
  stockQuantity: number;
}

// Augment the Express Request so downstream handlers can access req.sale.
declare module "express-serve-static-core" {
  interface Request {
    sale?: SaleSummary;
  }
}

/** Narrow lookup surface — one query per op. Implemented at the adapter
 *  layer (Mongoose or in-memory for single-sale) and injected at bootstrap. */
export interface SaleLookupOps {
  findBySlug(slug: string): Promise<SaleSummary | null>;
  /** Find the "active" sale: within [startTime, endTime) > nearest upcoming >
   *  most recently ended. Returns null if no sales exist. */
  findActiveSale(nowMs: number): Promise<SaleSummary | null>;
}

interface CacheEntry {
  sale: SaleSummary;
  expiresAt: number;
}

/** Story 4.4: the single conversion point from a resolved SaleSummary (Date
 *  fields) to the SaleWindow shape the status/order services expect (epoch
 *  ms + ISO strings) — every route handler that needs a window derives it
 *  from req.sale via this helper instead of re-deriving ad hoc. */
export function windowFromSale(sale: SaleSummary): SaleWindow {
  return {
    startMs: sale.startTime.getTime(),
    endMs: sale.endTime.getTime(),
    startIso: sale.startTime.toISOString(),
    endIso: sale.endTime.toISOString(),
  };
}

/**
 * Pure window-containment check — is `sale` live at `nowMs`?
 * Uses the [startTime, endTime) half-open interval as the single shared
 * definition of "currently active", referenced by both the priority
 * selection below and bootstrap.ts's boot-time overlap validation.
 */
export function isSaleActiveAt(sale: SaleSummary, nowMs: number): boolean {
  return sale.startTime.getTime() <= nowMs && nowMs < sale.endTime.getTime();
}

/** Story 4.5: priority-based active-sale selection over a candidate list —
 *  within window > nearest upcoming > most recently ended — extracted so
 *  boot-time reconciliation (bootstrap.ts) and any future Mongoose-backed
 *  `SaleLookupOps.findActiveSale()` implementation share one definition of
 *  "the active sale" instead of reimplementing this priority twice. Returns
 *  null for an empty list. */
export function selectActiveSale(sales: SaleSummary[], nowMs: number): SaleSummary | null {
  const active = sales.find((s) => isSaleActiveAt(s, nowMs));
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
}

export interface SaleResolverDeps {
  ops: SaleLookupOps;
  clock: Clock;
  /** Cache TTL in milliseconds. Default 60_000 (60s). Must be <= 60_000. */
  cacheTtlMs?: number;
}

export interface SaleResolver {
  /** Middleware for /:slug routes — resolves req.params.slug to req.sale.
   *  Returns 404 if the slug matches no Sale document. */
  forSlug(): (req: Request, res: Response, next: NextFunction) => Promise<void>;
  /** Middleware for v1.0 alias routes — resolves the active sale to req.sale.
   *  Non-blocking: always calls next() (v1.0 handlers use injected services). */
  forActiveSale(): (req: Request, res: Response, next: NextFunction) => Promise<void>;
  /** Direct lookup of the active sale (for the GET /api/sales/active endpoint). */
  findActive(): Promise<SaleSummary | null>;
}

export function createSaleResolver({ ops, clock, cacheTtlMs }: SaleResolverDeps): SaleResolver {
  const ttlMs = cacheTtlMs ?? 60_000;
  const slugCache = new Map<string, CacheEntry>();
  let activeCache: CacheEntry | null = null;

  async function resolveBySlug(slug: string): Promise<SaleSummary | null> {
    const now = clock();
    const cached = slugCache.get(slug);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.sale;
    }
    const sale = await ops.findBySlug(slug);
    if (sale !== null) {
      slugCache.set(slug, { sale, expiresAt: now + ttlMs });
    } else {
      slugCache.delete(slug);
    }
    return sale;
  }

  async function resolveActive(): Promise<SaleSummary | null> {
    const now = clock();
    if (activeCache !== null && activeCache.expiresAt > now) {
      return activeCache.sale;
    }
    const sale = await ops.findActiveSale(now);
    if (sale !== null) {
      activeCache = { sale, expiresAt: now + ttlMs };
    } else {
      activeCache = null;
    }
    return sale;
  }

  return {
    forSlug() {
      return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const raw = req.params.slug;
        const slug = Array.isArray(raw) ? raw[0] : raw;
        if (slug === undefined) {
          res.status(404).json({ success: false, error: "Sale not found." });
          return;
        }
        const sale = await resolveBySlug(slug);
        if (sale === null) {
          res.status(404).json({ success: false, error: "Sale not found." });
          return;
        }
        req.sale = sale;
        next();
      };
    },

    forActiveSale() {
      return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
        const sale = await resolveActive();
        if (sale !== null) {
          req.sale = sale;
        }
        next();
      };
    },

    async findActive(): Promise<SaleSummary | null> {
      return resolveActive();
    },
  };
}
