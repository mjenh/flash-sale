// Express assembly: helmet defaults -> pino-http (one line per request) ->
// 8 kb JSON limit -> /api router -> optional client/dist static -> envelope 404 ->
// ONE central error middleware. Express 5 propagates rejected async handlers
// here on its own — no per-route try/catch anywhere (NFR-6).
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";

export interface AppDeps {
  logger: Logger;
  apiRouter: Router;
  /** When set (container: /app/client/dist), the built SPA is served at /. */
  clientDistDir?: string | undefined;
}

interface HttpishError extends Error {
  status?: number;
  statusCode?: number;
}

export function createApp({ logger, apiRouter, clientDistDir }: AppDeps): Express {
  const app = express();

  app.use(helmet());
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: "8kb" }));

  app.use("/api", apiRouter);
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ success: false, error: "Not found." });
  });

  if (clientDistDir !== undefined) {
    app.use(express.static(clientDistDir));
  }

  app.use((err: HttpishError, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? err.statusCode ?? 500;
    const message = status < 500 && err.message !== "" ? err.message : "Internal server error.";
    if (status >= 500) {
      req.log.error({ err }, "unhandled error");
    } else {
      req.log.warn({ reason: err.message }, "request rejected");
    }
    res.status(status).json({ success: false, error: message });
  });

  return app;
}
