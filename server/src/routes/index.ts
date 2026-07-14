// API router — assembles the sale and order sub-routers.
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
