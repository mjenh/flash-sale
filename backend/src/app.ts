// Express assembly + central error middleware (envelope convention).
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { healthRouter } from "./routes/health.ts";
import type { HealthDeps } from "./services/health.ts";

export function buildApp(deps: HealthDeps): Express {
  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: "8kb" }));

  app.use("/api", healthRouter(deps));

  app.use((_req, res) => {
    res.status(404).json({ success: false, error: "Not found." });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[error]", err);
    res.status(500).json({ success: false, error: "Something went wrong, please try again." });
  });

  return app;
}
