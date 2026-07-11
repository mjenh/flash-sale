// HTTP translation layer only (AD-7). The API surface is exactly:
//   GET  /api/sale/status   (Story 1.2)
//   POST /api/order         (Story 1.3)
//   GET  /api/order/:email  (Story 1.5)
//   GET  /api/sale/events   (Story 1.6, SSE)
// No other routes without a PRD change (ARCHITECTURE-SPINE "API routes").
import { Router } from "express";

export function createApiRouter(): Router {
  return Router();
}
