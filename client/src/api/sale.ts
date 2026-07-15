// The wire contract, in one place. Native fetch + EventSource only.
//
// Defensive narrowing is not paranoia: a garbled or lying body must never
// become a painted state. If we cannot prove what the sale is doing, we say so
// (the caller renders the honest "can't reach the sale" treatment) rather than
// invent a status.
//
// Story 5.1: every URL is now slug-scoped (`/api/sales/${slug}/...`) instead
// of the v1.0 implicit-sale paths (`/api/sale/...`). The v1.0 constants are
// gone — a caller with no slug is a caller with a bug, so there is no
// unparameterized fallback to silently fall back to.
//
// Story 5.2: adds `fetchSaleDetails(slug)` (GET /api/sales/:slug — the
// Story 4.3 endpoint) and dedicated URL-construction coverage for every
// builder in this file. Not yet consumed by any component — ProductTile is
// still static/decorative — this is the API-layer capability Epic 4 shipped;
// wiring a component to it is out of scope here.

export type SaleState = "upcoming" | "active" | "sold_out" | "ended";

/** Shape shared by GET /api/sales/:slug/status and every SSE status frame. */
export interface SaleStatusBody {
  success: true;
  status: SaleState;
  stock: number;
  startTime: string;
  endTime: string;
}

/** URL builders — the one place that knows the slug-scoped path shape. The
 *  slug is a route param, never trusted raw into a path segment. */
export function saleStatusUrl(slug: string): string {
  return `/api/sales/${encodeURIComponent(slug)}/status`;
}

export function saleEventsUrl(slug: string): string {
  return `/api/sales/${encodeURIComponent(slug)}/events`;
}

export function saleDetailsUrl(slug: string): string {
  return `/api/sales/${encodeURIComponent(slug)}`;
}

/** Thrown by `fetchSaleStatus` when the API answers 404 for the given slug —
 *  a distinct, terminal outcome from "unreachable": the slug names no sale,
 *  so retrying the same URL can never succeed. The caller (useSaleStatus)
 *  uses this to stop polling/reconnecting and render "Sale not found"
 *  instead of endlessly retrying a request that can never come back true. */
export class SaleNotFoundError extends Error {
  constructor(slug: string) {
    super(`sale not found: ${slug}`);
    this.name = "SaleNotFoundError";
  }
}

const STATES: readonly string[] = ["upcoming", "active", "sold_out", "ended"];

/** Narrow an unknown payload to a valid SaleStatusBody, or return null. */
export function parseSaleStatus(raw: unknown): SaleStatusBody | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const body = raw as Record<string, unknown>;
  if (
    typeof body.status !== "string" ||
    !STATES.includes(body.status) ||
    typeof body.stock !== "number" ||
    // A stock count is a non-negative whole number — a fraction or a negative
    // is as unprovable as a string, and never becomes a painted numeral.
    !Number.isInteger(body.stock) ||
    body.stock < 0 ||
    typeof body.startTime !== "string" ||
    // An ISO instant that Date cannot parse would render "Invalid Date" into
    // the machine-truth chip — refuse it here rather than paint it.
    Number.isNaN(Date.parse(body.startTime)) ||
    typeof body.endTime !== "string" ||
    Number.isNaN(Date.parse(body.endTime))
  ) {
    return null;
  }
  return {
    success: true,
    status: body.status as SaleState,
    stock: body.stock,
    startTime: body.startTime,
    endTime: body.endTime,
  };
}

/** Rejects on any non-2xx (incl. the 503 fail-closed envelope) and on any body
 *  we cannot prove. A 404 rejects with the distinguished `SaleNotFoundError`
 *  so the caller can tell "this slug names no sale" apart from "the sale is
 *  temporarily unreachable" — the two states get different UI treatments. */
export async function fetchSaleStatus(slug: string, signal?: AbortSignal): Promise<SaleStatusBody> {
  const res = await fetch(saleStatusUrl(slug), { signal });
  if (res.status === 404) {
    throw new SaleNotFoundError(slug);
  }
  if (!res.ok) {
    throw new Error(`sale status unavailable (${res.status})`);
  }
  const body = parseSaleStatus(await res.json());
  if (body === null) {
    throw new Error("sale status body was not the expected shape");
  }
  return body;
}

/** Shape of a single product in `GET /api/sales/:slug` (Story 4.3's join).
 *  `remaining` is `null` when the endpoint degrades gracefully on a
 *  Redis-down read — see the server-side Dev Notes on Story 4.3. */
export interface SaleProductDetails {
  sku: string;
  name: string;
  initialQuantity: number;
  remaining: number | null;
}

/** Shape of `GET /api/sales/:slug`'s `sale` envelope. */
export interface SaleDetails {
  slug: string;
  name: string;
  startTime: string;
  endTime: string;
  stockQuantity: number;
  products: SaleProductDetails[];
}

function parseSaleProductDetails(raw: unknown): SaleProductDetails | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const p = raw as Record<string, unknown>;
  if (
    typeof p.sku !== "string" ||
    typeof p.name !== "string" ||
    typeof p.initialQuantity !== "number" ||
    !Number.isInteger(p.initialQuantity) ||
    p.initialQuantity < 0 ||
    (p.remaining !== null &&
      (typeof p.remaining !== "number" || !Number.isInteger(p.remaining) || p.remaining < 0))
  ) {
    return null;
  }
  return {
    sku: p.sku,
    name: p.name,
    initialQuantity: p.initialQuantity,
    remaining: p.remaining as number | null,
  };
}

/** Narrow an unknown payload to a valid SaleDetails, or return null. Same
 *  refuse-rather-than-invent discipline as `parseSaleStatus`. */
export function parseSaleDetails(raw: unknown): SaleDetails | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const body = raw as Record<string, unknown>;
  if (
    typeof body.slug !== "string" ||
    typeof body.name !== "string" ||
    typeof body.startTime !== "string" ||
    Number.isNaN(Date.parse(body.startTime)) ||
    typeof body.endTime !== "string" ||
    Number.isNaN(Date.parse(body.endTime)) ||
    typeof body.stockQuantity !== "number" ||
    !Number.isInteger(body.stockQuantity) ||
    body.stockQuantity < 0 ||
    !Array.isArray(body.products)
  ) {
    return null;
  }
  const products: SaleProductDetails[] = [];
  for (const raw of body.products) {
    const product = parseSaleProductDetails(raw);
    if (product === null) {
      return null;
    }
    products.push(product);
  }
  return {
    slug: body.slug,
    name: body.name,
    startTime: body.startTime,
    endTime: body.endTime,
    stockQuantity: body.stockQuantity,
    products,
  };
}

/** GET /api/sales/:slug (Story 4.3). Same 404/shape-refusal discipline as
 *  `fetchSaleStatus`. */
export async function fetchSaleDetails(slug: string, signal?: AbortSignal): Promise<SaleDetails> {
  const res = await fetch(saleDetailsUrl(slug), { signal });
  if (res.status === 404) {
    throw new SaleNotFoundError(slug);
  }
  if (!res.ok) {
    throw new Error(`sale details unavailable (${res.status})`);
  }
  const raw = await res.json();
  const body = parseSaleDetails((raw as { sale?: unknown }).sale ?? null);
  if (body === null) {
    throw new Error("sale details body was not the expected shape");
  }
  return body;
}
