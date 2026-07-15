// Fail closed: commands fail immediately while disconnected (no offline queueing).
//
// Finding #4 — TCP socket tuning: node-redis uses a single TCP connection.
// TCP pipelining handles high command throughput well for single-node Redis
// (100k+ simple commands/sec). The improvements below reduce per-command
// latency and detect stale connections faster:
//   noDelay: true   — disables Nagle's algorithm so each command is flushed
//                     immediately without waiting for the buffer to fill.
//   keepAlive: 5000 — sends TCP keepalive probes every 5 s, surfacing a broken
//                     connection to the reconnect strategy quickly rather than
//                     hanging until the command timeout fires.
// For true connection pooling, switch to ioredis or implement a manual pool;
// that is deferred to the roadmap (see LIMITATIONS.md).
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
      noDelay: true,
      keepAlive: 5_000,
    },
  });
  client.on("error", onError);
  return client;
}
