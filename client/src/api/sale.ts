// The wire contract, in one place. Native fetch + EventSource only — no axios,
// no socket library (AD-7: the client speaks HTTP to /api/*).
//
// Defensive narrowing is not paranoia: a garbled or lying body must never
// become a painted state. If we cannot prove what the sale is doing, we say so
// (the caller renders the honest "can't reach the sale" treatment) rather than
// invent a status.

export const SALE_STATUS_URL = "/api/sale/status";
export const SALE_EVENTS_URL = "/api/sale/events";

export type SaleState = "upcoming" | "active" | "sold_out" | "ended";

/** FR-1 body — identical on GET /api/sale/status and inside every SSE `status` frame. */
export interface SaleStatusBody {
  success: true;
  status: SaleState;
  stock: number;
  startTime: string;
  endTime: string;
}

const STATES: readonly string[] = ["upcoming", "active", "sold_out", "ended"];

/** Narrow an unknown payload to the FR-1 body, or return null. */
export function parseSaleStatus(raw: unknown): SaleStatusBody | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const body = raw as Record<string, unknown>;
  if (
    typeof body.status !== "string" ||
    !STATES.includes(body.status) ||
    typeof body.stock !== "number" ||
    !Number.isFinite(body.stock) ||
    typeof body.startTime !== "string" ||
    typeof body.endTime !== "string"
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
 *  we cannot prove. The caller decides what an unreachable sale means. */
export async function fetchSaleStatus(signal?: AbortSignal): Promise<SaleStatusBody> {
  const res = await fetch(SALE_STATUS_URL, { signal });
  if (!res.ok) {
    throw new Error(`sale status unavailable (${res.status})`);
  }
  const body = parseSaleStatus(await res.json());
  if (body === null) {
    throw new Error("sale status body was not the FR-1 shape");
  }
  return body;
}
