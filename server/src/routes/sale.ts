// GET /sale/status delegates to the sale-status service. GET /sale/events
// (SSE) only transports frames — the broadcaster owns composition,
// coalescing, and fail-closed. Snapshot is awaited before headers are sent,
// so a Redis-down rejection still becomes the 503 envelope through the
// central middleware.
import { Router } from "express";
import type { SaleStatusService } from "../services/sale-status.ts";
import type { SaleEventsBroadcaster, SseSink } from "../services/sale-events.ts";

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
      // Fresh-read snapshot FIRST: fails closed (503) while headers are unsent.
      snapshot = await saleEvents.snapshotFrame();
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
