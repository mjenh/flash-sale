// HTTP translation only: call one service, map result -> status + envelope.
import { Router } from "express";
import { checkHealth, type HealthDeps } from "../services/health.ts";

export function healthRouter(deps: HealthDeps): Router {
  const router = Router();
  router.get("/health", async (_req, res) => {
    const report = await checkHealth(deps);
    res
      .status(report.status === "ok" ? 200 : 503)
      .json({ success: report.status === "ok", ...report });
  });
  return router;
}
