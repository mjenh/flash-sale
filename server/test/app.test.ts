// Supertest with an injected router — no per-route try/catch anywhere;
// Express 5 async propagation.

import { Writable } from "node:stream";
import { type Request, type Response, Router } from "express";
import { type Logger, pino } from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { RedisUnavailableError } from "../src/adapters/redis/stock.ts";
import { createApp } from "../src/app.ts";

function captureLogger(): { lines: string[]; logger: Logger } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: pino(stream) };
}

function buildTestApp() {
  const router = Router();
  router.get("/boom", () => {
    throw new Error("sync kaboom");
  });
  router.get("/reject", async () => {
    throw new Error("async kaboom");
  });
  router.get("/teapot", () => {
    const err = new Error("I'm a teapot.") as Error & { status: number };
    err.status = 418;
    throw err;
  });
  router.get("/redis-down", async () => {
    throw new RedisUnavailableError();
  });
  router.post("/echo", (req: Request, res: Response) => {
    res.json({ success: true, body: req.body as unknown });
  });
  const { lines, logger } = captureLogger();
  return { app: createApp({ logger, apiRouter: router }), lines };
}

describe("createApp", () => {
  it("returns the envelope 404 for unknown /api routes", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Not found." });
  });

  it("maps a thrown (sync) error to a 500 envelope via the central middleware", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: "Internal server error." });
  });

  it("propagates rejected async handlers to the same middleware (Express 5)", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/reject");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: "Internal server error." });
  });

  it("keeps the exposed 503 fail-closed message while plain 5xx still collapse", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/redis-down");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: "Service temporarily unavailable." });
  });

  it("honours err.status and keeps 4xx messages in the envelope", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/teapot");
    expect(res.status).toBe(418);
    expect(res.body).toEqual({ success: false, error: "I'm a teapot." });
  });

  it("rejects JSON bodies over 8 kb with a 413 envelope", async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post("/api/echo")
      .set("content-type", "application/json")
      .send(`{"pad":"${"x".repeat(9000)}"}`);
    expect(res.status).toBe(413);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe("string");
  });

  it("rejects malformed JSON with a 400 envelope", async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post("/api/echo")
      .set("content-type", "application/json")
      .send("{nope");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("applies helmet defaults", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/does-not-exist");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("logs exactly one line per request (pino-http)", async () => {
    const { app, lines } = buildTestApp();
    await request(app).get("/api/does-not-exist");
    await new Promise((resolve) => setImmediate(resolve));
    const requestLines = lines.filter((line) => line.includes('"req"'));
    expect(requestLines).toHaveLength(1);
  });
});
