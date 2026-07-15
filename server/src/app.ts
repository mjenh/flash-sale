// Express 5 propagates rejected async handlers to the central error
// middleware on its own — no per-route try/catch needed.
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";

export interface AppDeps {
  logger: Logger;
  apiRouter: Router;
  /** When set (container: /app/client/dist), the built SPA is served at /. */
  clientDistDir?: string | undefined;
  /** Express JSON body size limit (default "8kb"). */
  bodyLimit?: string | undefined;
}

interface HttpishError extends Error {
  status?: number;
  statusCode?: number;
  /** http-errors convention: an exposed error keeps its message even at 5xx
   *  (e.g. RedisUnavailableError's 503 "Service temporarily unavailable."). */
  expose?: boolean;
}

export function createApp({ logger, apiRouter, clientDistDir, bodyLimit }: AppDeps): Express {
  const app = express();

  app.use(helmet());
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: bodyLimit ?? "8kb" }));

  app.use("/api", apiRouter);
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ success: false, error: "Not found." });
  });

  if (clientDistDir !== undefined) {
    app.use(express.static(clientDistDir));
  }

  app.use((err: HttpishError, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? err.statusCode ?? 500;
    const keepMessage = (status < 500 || err.expose === true) && err.message !== "";
    const message = keepMessage ? err.message : "Internal server error.";
    if (status >= 500) {
      req.log.error({ err }, "unhandled error");
    } else {
      req.log.warn({ reason: err.message }, "request rejected");
    }
    res.status(status).json({ success: false, error: message });
  });

  return app;
}
