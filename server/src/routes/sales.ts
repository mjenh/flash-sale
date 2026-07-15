// Slug-scoped routes — /api/sales/:slug/* delegates to the same handlers as
// v1.0 after the sale resolution middleware attaches req.sale. The /active
// discovery endpoint is mounted first to avoid :slug shadowing.
import { Router } from "express";
import type { SaleStatusService } from "../services/sale-status.ts";
import type { SaleEventsBroadcaster } from "../services/sale-events.ts";
import type { OrderService } from "../services/order.ts";
import type { SaleResolver } from "../middleware/sale-resolver.ts";
import type { CatalogReader } from "../adapters/mongo/catalog.ts";
import { RedisUnavailableError, type StockStore } from "../adapters/redis/stock.ts";
import { createSaleRouter } from "./sale.ts";
import { createOrderRouter } from "./order.ts";

export interface SalesRouterDeps {
  saleStatus: SaleStatusService;
  saleEvents: SaleEventsBroadcaster;
  orderService: OrderService;
  saleResolver: SaleResolver;
  catalog: CatalogReader;
  stock: StockStore;
}

export function createSalesRouter({
  saleStatus,
  saleEvents,
  orderService,
  saleResolver,
  catalog,
  stock,
}: SalesRouterDeps): Router {
  const router = Router();

  // Discovery endpoint — must come before :slug to avoid shadowing. Backed
  // by saleResolver.findActive(), which applies the within-window >
  // nearest-upcoming > most-recently-ended priority and returns 404 "No
  // sales configured." when no sale exists. The current single-sale-derived
  // ops (bootstrap.ts) are exact for N=1 sale; a real per-request Mongo
  // query is future work for true multi-sale support.
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

  // Sale details: Sale (from req.sale, no extra Mongo query) + the
  // Sale -> SaleProduct -> Product -> Inventory join from MongoDB +
  // remaining stock from Redis.
  //
  // Unlike the rest of the API, Redis-down degrades gracefully here
  // (remaining: null) rather than failing closed with 503 — this is
  // read-only informational data, not a stock-mutating decision. The catch
  // is scoped to exactly this call so only a Redis-down failure is
  // swallowed; any other error still propagates to the central 5xx handler.
  router.get("/:slug", async (req, res) => {
    const sale = req.sale;
    if (sale === undefined) {
      // Unreachable in practice — forSlug() above already 404s before this
      // handler runs. Defensive narrowing only (req.sale is optional on the
      // augmented Express Request type).
      res.status(404).json({ success: false, error: "Sale not found." });
      return;
    }

    const products = await catalog.listProductsForSale(sale._id);

    let remaining: number | null;
    try {
      remaining = await stock.getRemaining(sale._id);
    } catch (err) {
      if (!(err instanceof RedisUnavailableError)) {
        throw err;
      }
      remaining = null;
    }

    res.json({
      success: true,
      sale: {
        slug: sale.slug,
        name: sale.name,
        startTime: sale.startTime.toISOString(),
        endTime: sale.endTime.toISOString(),
        stockQuantity: sale.stockQuantity,
        products: products.map((product) => ({ ...product, remaining })),
      },
    });
  });

  // Delegate to existing v1.0 handlers (same sub-routers, mounted under /:slug).
  router.use("/:slug", createSaleRouter({ saleStatus, saleEvents }));
  router.use("/:slug/order", createOrderRouter({ orderService }));

  return router;
}
