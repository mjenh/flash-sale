// Validate the request (a 400 never touches Redis), call the order service,
// map the outcome to the wire contract. Rejections propagate via Express 5
// async handling to the central error middleware — no try/catch.
//
// Both handlers read req.sale (attached by the sale-resolver middleware) and
// pass its saleId/window through to the order service on every call, instead
// of a bootstrap-frozen saleId baked into the deps.
import { Router, type Request, type Response } from "express";
import type { OrderService } from "../services/order.ts";
import { windowFromSale } from "../middleware/sale-resolver.ts";

export interface OrderRouterDeps {
  orderService: OrderService;
}

const MAX_EMAIL_LENGTH = 256;

/** Minimal RFC 5321-compatible format check: local@domain.tld with no
 *  spaces and exactly one @. Deliberately liberal — strict RFC 5321
 *  parsing is complex and brittle for end-user UX. This gate is primarily
 *  a DDoS/slot-exhaustion defence (finding #2): it stops junk strings from
 *  consuming stock slots while accepting every address a real mail server
 *  would accept. Provider-specific aliasing (plus-tags, gmail dots) is not
 *  de-aliased — that is provider-specific and risky. */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The one source of the email hygiene rules: trim first; empty-after-trim,
 *  > 256 chars, or failing the format check is invalid. Shared by the POST
 *  body and the GET path param (Express hands the param in already
 *  percent-decoded).
 *
 *  The system's one business rule is "one item per email," so the stored Redis
 *  set key must be canonical — otherwise `A@b.com`, `a@b.com`, and NFC/NFD
 *  variants are three distinct customers and the rule is defeated by pressing
 *  Shift. We NFC-normalize and case-fold so those collapse to a single key
 *  (used identically by the POST write and the GET read, so a check always
 *  matches what was stored). The length gate stays on the trimmed form to keep
 *  the 256-char boundary exact. */
function canonicalEmail(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const email = raw.trim();
  if (email === "" || email.length > MAX_EMAIL_LENGTH) {
    return undefined;
  }
  const normalized = email.normalize("NFC").toLowerCase();
  if (!EMAIL_REGEX.test(normalized)) {
    return undefined;
  }
  return normalized;
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
    const sale = req.sale;
    if (sale === undefined) {
      // Unreachable in practice — forSlug() 404s first, and forActiveSale()
      // always finds the single boot-seeded sale. Defensive narrowing only.
      res.status(404).json({ success: false, error: "Sale not found." });
      return;
    }
    const email = validEmail(req.body);
    if (email === undefined) {
      res.status(400).json({ success: false, error: "Email is required." });
      return;
    }

    const result = await orderService.attempt({ saleId: sale._id, window: windowFromSale(sale) }, email);
    switch (result.outcome) {
      case "created":
        res.status(202).json({ success: true, email, message: "Order accepted." });
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

  // GET /api/order with no path param is the "path param is empty" case —
  // honest 400, not a generic 404 (Express 5 non-strict routing sends both
  // `/api/order` and `/api/order/` here).
  router.get("/", (_req: Request, res: Response) => {
    res.status(400).json({ success: false, error: "Email is required." });
  });

  // Convenience/idempotency read — answered from Redis membership only, never
  // Mongo, and never clock-gated. Both branches are 200 success bodies.
  router.get("/:email", async (req: Request, res: Response) => {
    const sale = req.sale;
    if (sale === undefined) {
      // Unreachable in practice — see the POST handler's comment above.
      res.status(404).json({ success: false, error: "Sale not found." });
      return;
    }
    const email = canonicalEmail(req.params.email);
    if (email === undefined) {
      res.status(400).json({ success: false, error: "Email is required." });
      return;
    }

    const ordered = await orderService.hasOrdered(sale._id, email);
    res.status(200).json({ success: true, ordered, email });
  });

  return router;
}
