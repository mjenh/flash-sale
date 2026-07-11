// HTTP translation only (AD-7): validate the request (AD-2 puts validation
// first — a 400 never touches Redis), call the order service, map the outcome
// to the verbatim wire contract. Rejections (incl. RedisUnavailableError 503)
// propagate via Express 5 async handling to the central error middleware —
// no try/catch. Story 1.5 adds GET /:email to this router.
import { Router, type Request, type Response } from "express";
import type { OrderService } from "../services/order.ts";

export interface OrderRouterDeps {
  orderService: OrderService;
}

const MAX_EMAIL_LENGTH = 256;

/** Trimmed canonical email, or undefined when the request must 400. */
function validEmail(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const raw = (body as Record<string, unknown>).email;
  if (typeof raw !== "string") {
    return undefined;
  }
  const email = raw.trim();
  if (email === "" || email.length > MAX_EMAIL_LENGTH) {
    return undefined;
  }
  return email;
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

  return router;
}
