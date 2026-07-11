// HTTP translation only (AD-7): validate the request (AD-2 puts validation
// first — a 400 never touches Redis), call the order service, map the outcome
// to the verbatim wire contract. Rejections (incl. RedisUnavailableError 503)
// propagate via Express 5 async handling to the central error middleware —
// no try/catch.
//   POST /            (Story 1.3 — atomic order attempt)
//   GET  /:email      (Story 1.5 — FR-4 order status check, Redis-only read)
import { Router, type Request, type Response } from "express";
import type { OrderService } from "../services/order.ts";

export interface OrderRouterDeps {
  orderService: OrderService;
}

const MAX_EMAIL_LENGTH = 256;

/** The one source of the email hygiene rules (spine conventions): trim first;
 *  empty-after-trim or > 256 chars is invalid. Shared by the POST body and the
 *  GET path param (Express hands the param in already percent-decoded). */
function canonicalEmail(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const email = raw.trim();
  if (email === "" || email.length > MAX_EMAIL_LENGTH) {
    return undefined;
  }
  return email;
}

/** Trimmed canonical email from a POST body, or undefined when it must 400. */
function validEmail(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  return canonicalEmail((body as Record<string, unknown>).email);
}

export function createOrderRouter({ orderService }: OrderRouterDeps): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    const email = validEmail(req.body);
    if (email === undefined) {
      res.status(400).json({ success: false, error: "Email is required." });
      return;
    }

    const result = await orderService.attempt(email);
    switch (result.outcome) {
      case "created":
        res.status(201).json({ success: true, email, message: "Order successful." });
        return;
      case "already":
        res.status(200).json({ success: true, email, message: "You have already ordered this item." });
        return;
      case "sold_out":
        res.status(409).json({ success: false, error: "Item is sold out." });
        return;
      case "inactive":
        res.status(409).json({ success: false, error: "Sale is not active." });
        return;
    }
  });

  // FR-4: GET /api/order with no path param is the "path param is empty" case
  // — honest 400, not a generic 404 (Express 5 non-strict routing sends both
  // `/api/order` and `/api/order/` here).
  router.get("/", (_req: Request, res: Response) => {
    res.status(400).json({ success: false, error: "Email is required." });
  });

  // FR-4 (Story 1.5): convenience/idempotency read (AD-8) — answered from
  // Redis membership only, never Mongo (AD-3), and never clock-gated. Both
  // branches are 200 success bodies; validation precedes the Redis read.
  router.get("/:email", async (req: Request, res: Response) => {
    const email = canonicalEmail(req.params.email);
    if (email === undefined) {
      res.status(400).json({ success: false, error: "Email is required." });
      return;
    }

    const ordered = await orderService.hasOrdered(email);
    res.status(200).json({ success: true, ordered, email });
  });

  return router;
}
