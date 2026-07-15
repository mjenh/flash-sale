// GET /status delegates to the sale-status service. GET /events (SSE) only
// transports frames — the broadcaster owns composition, coalescing, and
// fail-closed. Snapshot is awaited before headers are sent, so a Redis-down
// rejection still becomes the 503 envelope through the central middleware.
//
// Both handlers read req.sale (attached by forSlug() in the sale-resolver
// middleware) instead of a bootstrap-frozen saleId/window.
import { Router } from "express";
import type { SaleStatusService } from "../services/sale-status.ts";
import type { SaleEventsBroadcaster, SseSink } from "../services/sale-events.ts";
import { windowFromSale } from "../middleware/sale-resolver.ts";

export interface SaleRouterDeps {
  saleStatus: SaleStatusService;
  saleEvents: SaleEventsBroadcaster;
}

export function createSaleRouter({ saleStatus, saleEvents }: SaleRouterDeps): Router {
  const router = Router();

  router.get("/status", async (req, res) => {
    const sale = req.sale;
    if (sale === undefined) {
      // Defensive narrowing — forSlug() 404s before this handler runs when
      // the slug names no sale, but TypeScript cannot see through the
      // middleware chain.
      res.status(404).json({ success: false, error: "Sale not found." });
      return;
    }
    res.json(await saleStatus.getStatus(sale._id, windowFromSale(sale)));
  });

  router.get("/events", async (req, res) => {
    const sale = req.sale;
    if (sale === undefined) {
      // Defensive narrowing — forSlug() 404s before this handler runs when
      // the slug names no sale, but TypeScript cannot see through the
      // middleware chain.
      res.status(404).json({ success: false, error: "Sale not found." });
      return;
    }

    // Register the sink BEFORE composing the snapshot so a domain event that
    // arrives during the awaited read (e.g. sale.sold_out) is buffered, not
    // lost. Buffered frames flush right after the snapshot lands, preserving
    // order. Headers stay unsent until the snapshot resolves, so a Redis-down
    // rejection still becomes the exact 503 envelope.
    let ready = false;
    const buffered: string[] = [];
    const sink: SseSink = {
      write: (chunk) => {
        if (ready) {
          res.write(chunk);
        } else {
          buffered.push(chunk);
        }
      },
      end: () => {
        res.end();
      },
    };
    const unregister = saleEvents.register(sink);
    // Attach the close listener BEFORE the await so a socket that closes while
    // the snapshot is composed still unregisters the sink.
    res.on("close", unregister);

    let snapshot: string;
    try {
      // Fresh-read snapshot FIRST: fails closed (503) while headers are
      // unsent. Scoped to req.sale's saleId — the connect-time snapshot
      // always reflects the sale this specific connection resolved to.
      snapshot = await saleEvents.snapshotFrame(sale._id, windowFromSale(sale));
    } catch (err) {
      unregister();
      throw err; // headers unsent -> central middleware -> exact 503 envelope
    }

    // If the socket already closed during the await, the close listener may not
    // fire for a response destroyed pre-headers — unregister now.
    if (res.destroyed || res.writableEnded) {
      unregister();
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Snapshot on every (re)connect — no replay, no Last-Event-ID.
    res.write(snapshot);
    ready = true;
    // Flush any frames that arrived while the snapshot was being composed.
    for (const chunk of buffered.splice(0)) {
      res.write(chunk);
    }
  });

  return router;
}
