// The wire contract, in one place. Native fetch + EventSource only.
//
// Defensive narrowing is not paranoia: a garbled or lying body must never
// become a painted state. If we cannot prove what the sale is doing, we say so
// (the caller renders the honest "can't reach the sale" treatment) rather than
// invent a status.

export const SALE_STATUS_URL = "/api/sale/status";
export const SALE_EVENTS_URL = "/api/sale/events";

export type SaleState = "upcoming" | "active" | "sold_out" | "ended";

/** Shape shared by GET /api/sale/status and every SSE status frame. */
export interface SaleStatusBody {
  success: true;
  status: SaleState;
  stock: number;
  startTime: string;
  endTime: string;
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
 *  we cannot prove. The caller decides what an unreachable sale means. */
export async function fetchSaleStatus(signal?: AbortSignal): Promise<SaleStatusBody> {
  const res = await fetch(SALE_STATUS_URL, { signal });
  if (!res.ok) {
    throw new Error(`sale status unavailable (${res.status})`);
  }
  const body = parseSaleStatus(await res.json());
  if (body === null) {
    throw new Error("sale status body was not the expected shape");
  }
  return body;
}
