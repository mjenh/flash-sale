// HTTP translation only (AD-7): GET /sale/status → sale-status service →
// FR-1 body. Rejections (incl. RedisUnavailableError 503) propagate via
// Express 5 async handling to the central error middleware — no try/catch.
// Story 1.6 adds GET /sale/events (SSE) to this router.
import { Router } from "express";
import type { SaleStatusService } from "../services/sale-status.ts";

export interface SaleRouterDeps {
  saleStatus: SaleStatusService;
}

export function createSaleRouter({ saleStatus }: SaleRouterDeps): Router {
  const router = Router();

  router.get("/status", async (_req, res) => {
    res.json(await saleStatus.getStatus());
  });

  return router;
}
