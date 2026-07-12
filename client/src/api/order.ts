// The order contract. `placeOrder` NEVER throws: a 409, a 503, a dropped
// connection and a 10-second stall are all verdicts the buyer is owed, so the
// caller's state machine has no error branch that can strand a spinner.
//
// The wire field is `email` (PRD Amendment B) — the spine's older `userId`
// wording is superseded.

export const ORDER_URL = "/api/order";
export const TIMEOUT_MS = 10_000;

export const SUCCESS = "Order successful.";
export const ALREADY = "You have already ordered this item.";
export const SOLD_OUT = "Item is sold out.";
export const INACTIVE = "Sale is not active.";
export const EMAIL_REQUIRED = "Email is required.";
export const UNAVAILABLE = "Service temporarily unavailable.";
export const NETWORK = "Something went wrong, please try again.";

export type VerdictKind =
  | "success"
  | "already"
  | "sold_out"
  | "inactive"
  | "invalid"
  | "unavailable"
  | "network";

export interface Verdict {
  kind: VerdictKind;
  /** ALWAYS the verbatim string — never a paraphrase, never re-cased. */
  message: string;
}

/** The server's own words win. The constants are the expectation (pinned in
 *  tests); the wire is the source of truth. A server-side wording change must
 *  show up on the page, not be silently overwritten by a stale constant. */
function said(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.message === "string" && record.message !== "") {
      return record.message;
    }
    if (typeof record.error === "string" && record.error !== "") {
      return record.error;
    }
  }
  return fallback;
}

function verdictFor(status: number, body: unknown): Verdict {
  switch (status) {
    case 201:
      return { kind: "success", message: said(body, SUCCESS) };
    case 200:
      return { kind: "already", message: said(body, ALREADY) };
    case 400:
      return { kind: "invalid", message: said(body, EMAIL_REQUIRED) };
    case 503:
      return { kind: "unavailable", message: said(body, UNAVAILABLE) };
    case 409: {
      const message = said(body, SOLD_OUT);
      // One 409, two business rejections — told apart by the string itself.
      return message === INACTIVE
        ? { kind: "inactive", message }
        : { kind: "sold_out", message };
    }
    default:
      return { kind: "network", message: NETWORK };
  }
}

/** POST /api/order. Total by construction — every path resolves a Verdict. */
export async function placeOrder(email: string): Promise<Verdict> {
  const controller = new AbortController();
  // A ~10s stall is an answer too. Abort for real, so a hung socket doesn't
  // hold a connection slot while the buyer retries (retry is safe: idempotent).
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const res = await fetch(ORDER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return verdictFor(res.status, body);
  } catch {
    return { kind: "network", message: NETWORK };
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/order/:email — the UJ-2 convenience read (AD-8: never how you
 *  learn the outcome of the attempt you just made). Rejects on failure; the
 *  caller swallows it silently. */
export async function checkOrder(email: string, signal?: AbortSignal): Promise<boolean> {
  const res = await fetch(`${ORDER_URL}/${encodeURIComponent(email)}`, { signal });
  if (!res.ok) {
    throw new Error(`order check failed (${res.status})`);
  }
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || typeof (body as { ordered?: unknown }).ordered !== "boolean") {
    throw new Error("order check body was not the FR-4 shape");
  }
  return (body as { ordered: boolean }).ordered;
}
