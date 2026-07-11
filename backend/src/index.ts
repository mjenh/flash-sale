// Boot: config -> connect stores -> listen. Fail fast on bad config (AD-6).
import { loadConfig } from "./adapters/config/index.ts";
import { connectMongo, mongoReady } from "./adapters/mongo/client.ts";
import { connectRedis } from "./adapters/redis/client.ts";
import { buildApp } from "./app.ts";

async function bootstrap(): Promise<void> {
  const config = loadConfig();

  const redis = await connectRedis(config.redisUrl);
  await connectMongo(config.mongoUrl);

  const app = buildApp({
    redisPing: () => redis.ping(),
    mongoReady,
  });

  app.listen(config.port, () => {
    console.log(`[backend] listening on :${config.port}`);
  });
}

bootstrap().catch((err) => {
  console.error("[backend] boot failed:", err);
  process.exit(1);
});
