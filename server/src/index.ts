// Boot: bootstrap() -> listen. Fail fast with a non-zero exit on bad config
// or unreachable stores, strictly before listen() (AD-6).
import { bootstrap } from "./bootstrap.ts";

bootstrap()
  .then(({ app, config, logger }) => {
    app.listen(config.port, () => {
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
  })
  .catch((err: unknown) => {
    console.error("[boot] failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
