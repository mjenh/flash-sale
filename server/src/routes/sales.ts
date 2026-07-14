// Slug-scoped routes — /api/sales/:slug/* delegates to the same handlers as
// v1.0 after the sale resolution middleware attaches req.sale. The /active
// discovery endpoint is mounted first to avoid :slug shadowing.
import { Router } from "express";
import type { SaleStatusService } from "../services/sale-status.ts";
import type { SaleEventsBroadcaster } from "../services/sale-events.ts";
import type { OrderService } from "../services/order.ts";
import type { SaleResolver } from "../middleware/sale-resolver.ts";
import { createSaleRouter } from "./sale.ts";
import { createOrderRouter } from "./order.ts";

export interface SalesRouterDeps {
  saleStatus: SaleStatusService;
  saleEvents: SaleEventsBroadcaster;
  orderService: OrderService;
  saleResolver: SaleResolver;
}

export function createSalesRouter({
  saleStatus,
  saleEvents,
  orderService,
  saleResolver,
}: SalesRouterDeps): Router {
  const router = Router();

  // Discovery endpoint — must come before :slug to avoid shadowing.
  // Full implementation in Story 5.3; scaffolded here with the resolver.
  router.get("/active", async (_req, res) => {
    const sale = await saleResolver.findActive();
    if (sale === null) {
      res.status(404).json({ success: false, error: "No sales configured." });
      return;
    }
    res.json({ success: true, slug: sale.slug });
  });

  // Sale resolution middleware for all :slug routes.
  router.use("/:slug", saleResolver.forSlug());

  // Sale details — placeholder for Story 4.3 (full product/inventory join).
  router.get("/:slug", (_req, res) => {
    const sale = _req.sale;
    res.json({
      success: true,
      sale: sale === undefined
        ? undefined
        : {
            slug: sale.slug,
            startTime: sale.startTime.toISOString(),
            endTime: sale.endTime.toISOString(),
            stockQuantity: sale.stockQuantity,
          },
    });
  });

  // Delegate to existing v1.0 handlers (same sub-routers, mounted under /:slug).
  router.use("/:slug", createSaleRouter({ saleStatus, saleEvents }));
  router.use("/:slug/order", createOrderRouter({ orderService }));

  return router;
}
