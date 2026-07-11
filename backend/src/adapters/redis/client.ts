// Redis adapter: client with bounded connect/command timeouts (AD-5: fail closed).
import { createClient, type RedisClientType } from "redis";

const CONNECT_TIMEOUT_MS = 2000;

export type RedisClient = RedisClientType;

export async function connectRedis(url: string): Promise<RedisClient> {
  const client: RedisClientType = createClient({
    url,
    socket: {
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries: number) => Math.min(retries * 100, 2000),
    },
  });
  client.on("error", (err: Error) => {
    console.error("[redis] error:", err.message);
  });
  await client.connect();
  return client;
}
