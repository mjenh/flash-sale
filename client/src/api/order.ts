// The order contract. `placeOrder` NEVER throws: a 409, a 503, a dropped
// connection and a 10-second stall are all verdicts the buyer is owed, so the
// caller's state machine has no error branch that can strand a spinner.
//
// The wire field is `email` — the spine's older `userId` wording is superseded.
//
// Story 5.1: both `placeOrder` and `checkOrder` now take a `slug` and call
// `/api/sales/${slug}/order[...]` instead of the v1.0 `/api/order[...]`
// paths. Story 5.2 will extend this file further (dedicated URL-construction
// tests, additional cleanup); this story's job was making the order flow
// actually work end-to-end with a slug in the URL.

export const TIMEOUT_MS = 10_000;

export const SUCCESS = "Order successful.";
export const ALREADY = "You have already ordered this item.";
export const SOLD_OUT = "Item is sold out.";
export const INACTIVE = "Sale is not active.";
export const EMAIL_REQUIRED = "Email is required.";
export const UNAVAILABLE = "Service temporarily unavailable.";
export const NETWORK = "Something went wrong, please try again.";

/** URL builders — the one place that knows the slug-scoped path shape. */
export function orderUrl(slug: string): string {
  return `/api/sales/${encodeURIComponent(slug)}/order`;
}

export function checkOrderUrl(slug: string, email: string): string {
  return `${orderUrl(slug)}/${encodeURIComponent(email)}`;
}

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

/** A 200/201 is only trustworthy if the body is actually an order envelope. A
 *  captive portal or proxy can answer 200 with HTML (which fails to parse, so
 *  `body` is null) — mapping that to "already ordered" or "success" would tell a
 *  buyer who ordered nothing that they hold an order. `success: false` is never
 *  a positive outcome either. */
function isOrderEnvelope(body: unknown): boolean {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const record = body as Record<string, unknown>;
  if (record.success === false) {
    return false;
  }
  return typeof record.message === "string" || record.success === true;
}

function verdictFor(status: number, body: unknown): Verdict {
  switch (status) {
    case 201:
      return isOrderEnvelope(body)
        ? { kind: "success", message: said(body, SUCCESS) }
        : { kind: "network", message: NETWORK };
    case 200:
      return isOrderEnvelope(body)
        ? { kind: "already", message: said(body, ALREADY) }
        : { kind: "network", message: NETWORK };
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

/** POST /api/sales/:slug/order. Total by construction — every path resolves a
 *  Verdict. */
export async function placeOrder(slug: string, email: string): Promise<Verdict> {
  const controller = new AbortController();
  // A ~10s stall is an answer too. Abort for real, so a hung socket doesn't
  // hold a connection slot while the buyer retries (retry is safe: idempotent).
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const res = await fetch(orderUrl(slug), {
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

/** GET /api/sales/:slug/order/:email — a convenience read, never how you learn
 *  the outcome of the attempt you just made. Rejects on failure; the caller
 *  swallows it silently. A hung load-check must not resolve late and pop a
 *  focus-stealing panel, so it carries its own timeout AND honors the
 *  caller's signal (aborted on submit / unmount). */
export async function checkOrder(slug: string, email: string, signal?: AbortSignal): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  // Chain the caller's signal into our own so either source can abort the fetch.
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  try {
    const res = await fetch(checkOrderUrl(slug, email), {
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`order check failed (${res.status})`);
    }
    const body: unknown = await res.json();
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { ordered?: unknown }).ordered !== "boolean"
    ) {
      throw new Error("order check body was not the expected shape");
    }
    return (body as { ordered: boolean }).ordered;
  } finally {
    clearTimeout(timer);
  }
}
