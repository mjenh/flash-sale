// API router — assembles the v1.1 slug-scoped sales router and the v1.0
// alias sub-routers. The sale resolution middleware attaches req.sale to
// every request before downstream handlers run.
import { Router } from "express";
import type { SaleStatusService } from "../services/sale-status.ts";
import type { SaleEventsBroadcaster } from "../services/sale-events.ts";
import type { OrderService } from "../services/order.ts";
import type { SaleResolver } from "../middleware/sale-resolver.ts";
import { createSaleRouter } from "./sale.ts";
import { createOrderRouter } from "./order.ts";
import { createSalesRouter } from "./sales.ts";

export interface ApiRouterDeps {
  saleStatus: SaleStatusService;
  saleEvents: SaleEventsBroadcaster;
  orderService: OrderService;
  saleResolver: SaleResolver;
}

export function createApiRouter({ saleStatus, saleEvents, orderService, saleResolver }: ApiRouterDeps): Router {
  const router = Router();
  // v1.1 slug-scoped routes (includes /sales/active discovery endpoint).
  router.use("/sales", createSalesRouter({ saleStatus, saleEvents, orderService, saleResolver }));
  // v1.0 alias routes — resolve the active sale before handlers.
  router.use("/sale", saleResolver.forActiveSale(), createSaleRouter({ saleStatus, saleEvents }));
  router.use("/order", saleResolver.forActiveSale(), createOrderRouter({ orderService }));
  return router;
}
