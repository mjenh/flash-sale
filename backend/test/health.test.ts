// Unit tests: services with fake adapters (no I/O), supertest against the app.
import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.ts";
import { checkHealth } from "../src/services/health.ts";

const healthy = { redisPing: async () => "PONG", mongoReady: () => true };
const redisDown = {
  redisPing: async () => {
    throw new Error("down");
  },
  mongoReady: () => true,
};

describe("checkHealth", () => {
  it("reports ok when both stores are up", async () => {
    expect(await checkHealth(healthy)).toEqual({ status: "ok", redis: true, mongo: true });
  });

  it("reports degraded when redis is down", async () => {
    expect(await checkHealth(redisDown)).toEqual({ status: "degraded", redis: false, mongo: true });
  });
});

describe("GET /api/health", () => {
  it("returns 200 with envelope when healthy", async () => {
    const res = await request(buildApp(healthy)).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: "ok" });
  });

  it("returns 503 when redis is down (fail closed)", async () => {
    const res = await request(buildApp(redisDown)).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
  });
});
