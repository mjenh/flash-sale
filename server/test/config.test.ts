// Pure, no I/O.
// Story 6-1: sale timing, stock quantity, slugs, names, and pricing are now
// read from MongoDB at boot — not from env vars. This file tests only the
// infra env vars that AppConfig still validates (port, URLs, timeouts).
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/adapters/config.ts";

describe("loadConfig", () => {
  it("parses a valid environment with explicit infra overrides", () => {
    const config = loadConfig({
      PORT: "4000",
      REDIS_URL: "redis://example:6379",
      MONGODB_URI: "mongodb://example:27017/flash-sale",
    });
    expect(config.port).toBe(4000);
    expect(config.redisUrl).toBe("redis://example:6379");
    expect(config.mongodbUri).toBe("mongodb://example:27017/flash-sale");
    expect(config.redisConnectTimeoutMs).toBeGreaterThan(0);
  });

  it("carries a bounded per-command Redis timeout", () => {
    const config = loadConfig({});
    expect(config.redisCommandTimeoutMs).toBe(1000);
  });

  it("applies defaults: PORT 3000, local store URLs", () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.redisUrl).toBe("redis://localhost:6379");
    expect(config.mongodbUri).toBe("mongodb://localhost:27017/flash-sale");
  });

  it.each([["0"], ["-1"], ["nope"], ["70000"]])("rejects PORT %s", (value) => {
    expect(() => loadConfig({ PORT: value })).toThrowError(ConfigError);
  });

  it("rejects SALE_RESOLVER_CACHE_TTL_MS > 60000", () => {
    expect(() => loadConfig({ SALE_RESOLVER_CACHE_TTL_MS: "99999" })).toThrowError(ConfigError);
  });

  it("accepts SALE_RESOLVER_CACHE_TTL_MS at the 60000 boundary", () => {
    const config = loadConfig({ SALE_RESOLVER_CACHE_TTL_MS: "60000" });
    expect(config.saleResolverCacheTtlMs).toBe(60000);
  });

  it("rejects REDIS_CONNECT_TIMEOUT_MS <= 0", () => {
    expect(() => loadConfig({ REDIS_CONNECT_TIMEOUT_MS: "0" })).toThrowError(ConfigError);
  });

  it("accepts explicit MONGO_SELECTION_TIMEOUT_MS", () => {
    const config = loadConfig({ MONGO_SELECTION_TIMEOUT_MS: "8000" });
    expect(config.mongoSelectionTimeoutMs).toBe(8000);
  });
});
