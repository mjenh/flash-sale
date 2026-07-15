// Boot: bootstrap() -> listen. Fail fast with a non-zero exit on bad config
// or unreachable stores, strictly before listen().
//
// WORKER_COLOCATED=true (env flag): starts the write-behind worker in this
// same process. Convenient for single-container deployments; set to false (or
// omit) to run the worker as a separate process (src/worker/index.ts).
import { bootstrap } from "./bootstrap.ts";
import { createOrderWorker } from "./worker/order-worker.ts";
import { mongoBulkAudit } from "./adapters/mongo/bulk-audit.ts";

bootstrap()
  .then(({ app, config, logger, redis, teardown }) => {
    // Co-located worker (optional). The worker is pure async — it never blocks
    // the HTTP event loop. Use WORKER_COLOCATED=true for simple single-process
    // deployments; leave it unset to run the worker as a separate container.
    const colocated = process.env["WORKER_COLOCATED"] === "true";
    const worker = colocated
      ? createOrderWorker({ redis, bulkAudit: mongoBulkAudit, logger })
      : null;
    if (worker !== null) {
      worker.start();
      logger.info("write-behind worker started (co-located)");
    }

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
      // If co-located, finish the current batch before the main teardown runs.
      const workerStop = worker !== null ? worker.stop() : Promise.resolve();
      workerStop
        .then(() => teardown())
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
