// Boot: bootstrap() -> listen. Fail fast with a non-zero exit on bad config
// or unreachable stores, strictly before listen().
import { bootstrap } from "./bootstrap.ts";

bootstrap()
  .then(({ app, config, logger, teardown }) => {
    const server = app.listen(config.port, () => {
      logger.info(
        {
          port: config.port,
          saleStart: config.saleStartIso,
          saleEnd: config.saleEndIso,
          stock: config.stockQuantity,
        },
        "flash-sale api listening",
      );
    });

    // Node is container PID 1, so default signal dispositions don't apply —
    // handle SIGTERM/SIGINT explicitly to run the ordered teardown.
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      logger.info({ signal }, "shutting down; draining connections then tearing down");
      server.close();
      teardown()
        .then(() => {
          process.exit(0);
        })
        .catch((err: unknown) => {
          logger.error({ err }, "teardown failed during shutdown");
          process.exit(1);
        });
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  })
  .catch((err: unknown) => {
    console.error("[boot] failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
