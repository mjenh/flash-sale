import { describe, expect, it } from "vitest";
import { loadStressConfig, SALE_SLUG, StressConfigError } from "../config.ts";

describe("loadStressConfig", () => {
  it("defaults to the documented 5,000-vs-100 run against localhost", () => {
    const config = loadStressConfig({});

    expect(config).toEqual({
      apiUrl: "http://localhost:3000",
      redisUrl: "redis://localhost:6379",
      mongodbUri: "mongodb://localhost:27017/flash-sale",
      stockQuantity: 100,
      attempts: 5000,
      vus: 500,
      retry: false,
    });
  });

  it("strips a trailing slash from API_URL so paths never double up", () => {
    expect(loadStressConfig({ API_URL: "http://api:3000/" }).apiUrl).toBe("http://api:3000");
  });

  it("fails fast on a non-positive STOCK_QUANTITY", () => {
    expect(() => loadStressConfig({ STOCK_QUANTITY: "0" })).toThrow(StressConfigError);
    expect(() => loadStressConfig({ STOCK_QUANTITY: "-1" })).toThrow(StressConfigError);
    expect(() => loadStressConfig({ STOCK_QUANTITY: "1.5" })).toThrow(StressConfigError);
  });

  it("fails fast on a non-integer ATTEMPTS", () => {
    expect(() => loadStressConfig({ ATTEMPTS: "many" })).toThrow(StressConfigError);
  });

  it("refuses more VUs than attempts — idle VUs would fake a burst", () => {
    expect(() => loadStressConfig({ VUS: "5000", ATTEMPTS: "100" })).toThrow(StressConfigError);
  });

  it("enables the retry scenario with RETRY=1", () => {
    expect(loadStressConfig({ RETRY: "1" }).retry).toBe(true);
  });

  it("pins the sale slug the API seeds (server/src/adapters/mongo/seed.ts)", () => {
    expect(SALE_SLUG).toBe("flash-sale");
  });
});
