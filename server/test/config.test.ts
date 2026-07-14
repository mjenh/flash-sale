// Pure, no I/O.
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/adapters/config.ts";

const valid = {
  SALE_START_TIME: "2026-07-10T04:00:00Z",
  SALE_END_TIME: "2026-07-10T05:00:00Z",
};

describe("loadConfig", () => {
  it("parses a valid environment, converting the window to UTC epoch ms exactly once", () => {
    const config = loadConfig({
      ...valid,
      STOCK_QUANTITY: "50",
      PORT: "4000",
      REDIS_URL: "redis://example:6379",
      MONGODB_URI: "mongodb://example:27017/flash-sale",
    });
    expect(config.saleStartMs).toBe(Date.parse("2026-07-10T04:00:00Z"));
    expect(config.saleEndMs).toBe(Date.parse("2026-07-10T05:00:00Z"));
    expect(config.saleStartIso).toBe("2026-07-10T04:00:00.000Z");
    expect(config.saleEndIso).toBe("2026-07-10T05:00:00.000Z");
    expect(config.stockQuantity).toBe(50);
    expect(config.port).toBe(4000);
    expect(config.redisUrl).toBe("redis://example:6379");
    expect(config.mongodbUri).toBe("mongodb://example:27017/flash-sale");
    expect(config.redisConnectTimeoutMs).toBeGreaterThan(0);
  });

  it("carries a bounded per-command Redis timeout", () => {
    const config = loadConfig(valid);
    expect(config.redisCommandTimeoutMs).toBe(1000);
  });

  it("normalizes timezone offsets to UTC (PRD open question 2 resolution)", () => {
    const config = loadConfig({
      SALE_START_TIME: "2026-07-10T09:00:00+08:00",
      SALE_END_TIME: "2026-07-10T10:00:00+08:00",
    });
    expect(config.saleStartIso).toBe("2026-07-10T01:00:00.000Z");
    expect(config.saleEndIso).toBe("2026-07-10T02:00:00.000Z");
  });

  it("applies defaults: STOCK_QUANTITY 100, PORT 3000, local store URLs (PRD 8.4)", () => {
    const config = loadConfig(valid);
    expect(config.stockQuantity).toBe(100);
    expect(config.port).toBe(3000);
    expect(config.redisUrl).toBe("redis://localhost:6379");
    expect(config.mongodbUri).toBe("mongodb://localhost:27017/flash-sale");
  });

  it.each([
    ["missing SALE_START_TIME", { SALE_END_TIME: valid.SALE_END_TIME }],
    ["missing SALE_END_TIME", { SALE_START_TIME: valid.SALE_START_TIME }],
    ["empty SALE_START_TIME", { ...valid, SALE_START_TIME: "  " }],
    ["invalid SALE_START_TIME", { ...valid, SALE_START_TIME: "not-a-date" }],
    ["invalid SALE_END_TIME", { ...valid, SALE_END_TIME: "2026-13-99T99:99:99Z" }],
    ["offset-less SALE_START_TIME", { ...valid, SALE_START_TIME: "2026-07-10T09:00:00" }],
    ["offset-less SALE_END_TIME", { ...valid, SALE_END_TIME: "2026-07-10T10:00:00" }],
  ])("fails fast on %s", (_name, env) => {
    expect(() => loadConfig(env)).toThrowError(ConfigError);
  });

  it("rejects an offset-less sale time with a clear timezone message (never parsed as host-local)", () => {
    expect(() => loadConfig({ ...valid, SALE_START_TIME: "2026-07-10T09:00:00" })).toThrowError(
      /explicit timezone offset/,
    );
  });

  it("rejects SALE_END_TIME equal to SALE_START_TIME", () => {
    expect(() =>
      loadConfig({ SALE_START_TIME: valid.SALE_START_TIME, SALE_END_TIME: valid.SALE_START_TIME }),
    ).toThrowError(/strictly after/);
  });

  it("rejects SALE_END_TIME before SALE_START_TIME", () => {
    expect(() =>
      loadConfig({ SALE_START_TIME: valid.SALE_END_TIME, SALE_END_TIME: valid.SALE_START_TIME }),
    ).toThrowError(/strictly after/);
  });

  it.each([["0"], ["-5"], ["1.5"], ["abc"], ["1e20"]])(
    "rejects STOCK_QUANTITY %s (must be a positive SAFE integer)",
    (value) => {
      expect(() => loadConfig({ ...valid, STOCK_QUANTITY: value })).toThrowError(ConfigError);
    },
  );

  it.each([["0"], ["-1"], ["nope"], ["70000"]])("rejects PORT %s", (value) => {
    expect(() => loadConfig({ ...valid, PORT: value })).toThrowError(ConfigError);
  });
});
