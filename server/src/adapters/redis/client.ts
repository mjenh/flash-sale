// Fail closed: commands fail immediately while disconnected (no offline queueing).
import { createClient, type RedisClientType } from "redis";

export type RedisClient = RedisClientType;

export interface RedisOptions {
  redisUrl: string;
  redisConnectTimeoutMs: number;
}

export function createRedisClient(
  options: RedisOptions,
  onError: (err: Error) => void = () => {},
): RedisClient {
  const client: RedisClientType = createClient({
    url: options.redisUrl,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: options.redisConnectTimeoutMs,
      reconnectStrategy: (retries: number) => Math.min(retries * 100, 2000),
    },
  });
  client.on("error", onError);
  return client;
}
