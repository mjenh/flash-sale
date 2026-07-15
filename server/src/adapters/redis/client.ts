// Fail closed: commands fail immediately while disconnected (no offline queueing).
import { createClient, type RedisClientType } from "redis";

export type RedisClient = RedisClientType;

export interface RedisOptions {
  redisUrl: string;
  redisConnectTimeoutMs: number;
  /** Ceiling for the exponential reconnect backoff in ms (default 2000). */
  redisReconnectMaxMs: number;
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
      reconnectStrategy: (retries: number) =>
        Math.min(retries * 100, options.redisReconnectMaxMs),
    },
  });
  client.on("error", onError);
  return client;
}
