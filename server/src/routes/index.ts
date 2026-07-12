// HTTP translation layer only (AD-7). The API surface is exactly:
//   GET  /api/sale/status   (Story 1.2 — live)
//   POST /api/order         (Story 1.3 — live)
//   GET  /api/order/:email  (Story 1.5 — live)
//   GET  /api/sale/events   (Story 1.6 — live, SSE)
// The surface is complete — no other routes without a PRD change
// (ARCHITECTURE-SPINE "API routes").
import { Router } from "express";
import type { SaleStatusService } from "../services/sale-status.ts";
import type { SaleEventsBroadcaster } from "../services/sale-events.ts";
import type { OrderService } from "../services/order.ts";
import { createSaleRouter } from "./sale.ts";
import { createOrderRouter } from "./order.ts";

export interface ApiRouterDeps {
  saleStatus: SaleStatusService;
  saleEvents: SaleEventsBroadcaster;
  orderService: OrderService;
}

export function createApiRouter({ saleStatus, saleEvents, orderService }: ApiRouterDeps): Router {
  const router = Router();
  router.use("/sale", createSaleRouter({ saleStatus, saleEvents }));
  router.use("/order", createOrderRouter({ orderService }));
  return router;
}
