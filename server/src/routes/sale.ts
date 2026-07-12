// HTTP translation only (AD-7): GET /sale/status → sale-status service →
// FR-1 body. Rejections (incl. RedisUnavailableError 503) propagate via
// Express 5 async handling to the central error middleware — no try/catch.
//
// GET /sale/events (Story 1.6, SSE): the route only TRANSPORTS frames
// (AD-9) — the broadcaster owns composition, coalescing, and fail-closed.
// Snapshot is awaited BEFORE headers are sent, so a Redis-down rejection
// still becomes the exact 503 envelope through the central middleware.
import { Router } from "express";
import type { SaleStatusService } from "../services/sale-status.ts";
import type { SaleEventsBroadcaster } from "../services/sale-events.ts";

export interface SaleRouterDeps {
  saleStatus: SaleStatusService;
  saleEvents: SaleEventsBroadcaster;
}

export function createSaleRouter({ saleStatus, saleEvents }: SaleRouterDeps): Router {
  const router = Router();

  router.get("/status", async (_req, res) => {
    res.json(await saleStatus.getStatus());
  });

  router.get("/events", async (_req, res) => {
    // Fresh-read snapshot FIRST: fails closed (503) while headers are unsent.
    const snapshot = await saleEvents.snapshotFrame();

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Snapshot on EVERY (re)connect — no replay, no Last-Event-ID (AD-9).
    res.write(snapshot);

    const unregister = saleEvents.register({
      write: (chunk) => {
        res.write(chunk);
      },
      end: () => {
        res.end();
      },
    });
    res.on("close", unregister);
  });

  return router;
}
