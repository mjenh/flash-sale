// Integration tests for the Express application infrastructure:
//   - GET /health — the health probe
//   - Catch-all 404 under /api — routes that don't match any handler
//   - Body size limit — the default 8 kb limit (PayloadTooLarge → 413)
//   - Malformed JSON body — SyntaxError from the body parser → 400
//
// These exercise the createApp() layer (app.ts) wired through the REAL
// bootstrap(), ensuring middleware ordering and error handling are correct
// end-to-end and not just in isolation.

import { pino } from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { SALE_SLUG } from "../src/adapters/mongo/seed.ts";
import { type BootstrapOverrides, bootstrap } from "../src/bootstrap.ts";
import { createFakeMongo, reserveSaleId } from "./helpers/fake-mongo.ts";
import { createFakeRedis } from "./helpers/fake-redis.ts";
import { IN_WINDOW } from "./helpers/time-fixtures.ts";

async function boot() {
  const mongo = createFakeMongo();
  const saleId = await reserveSaleId(mongo, SALE_SLUG);
  const fake = createFakeRedis({ stock: "50", saleId });
  const overrides: BootstrapOverrides = {
    env: {},
    logger: pino({ level: "silent" }),
    clock: () => IN_WINDOW,
    createRedis: () => fake.client,
    connectRedis: vi.fn(async () => {}),
    disconnectRedis: vi.fn(async () => {}),
    connectMongoDb: vi.fn(async () => {}),
    disconnectMongoDb: vi.fn(async () => {}),
    mongoModelOps: mongo.ops,
  };
  const { app } = await bootstrap(overrides);
  return { app };
}

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  it("responds 200 { ok: true } regardless of sale state", async () => {
    const { app } = await boot();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("is accessible without any Authorization header", async () => {
    const { app } = await boot();
    const res = await request(app).get("/health");
    // No auth layer on this app; the probe must never 401 or 403.
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Catch-all 404 under /api
// Any route that falls through the API router returns the structured error body.
// ---------------------------------------------------------------------------

describe("catch-all 404 for unrecognized /api routes", () => {
  it("404 for a path that has no handler under /api", async () => {
    const { app } = await boot();
    const res = await request(app).get("/api/completely-unknown");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Not found." });
  });

  it("404 for a sub-path of /api/sales that has no defined route", async () => {
    const { app } = await boot();
    const res = await request(app).get(`/api/sales/${SALE_SLUG}/nonexistent-subroute`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Not found." });
  });

  it("404 for POST to an unrecognised /api path", async () => {
    const { app } = await boot();
    const res = await request(app).post("/api/unknown-resource").send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Not found." });
  });
});

// ---------------------------------------------------------------------------
// Sale-resolver 404 (distinct from the catch-all — "Sale not found." body)
// ---------------------------------------------------------------------------

describe("404 from the sale resolver — unknown slug", () => {
  it("returns the sale-resolver 404, not the catch-all, for an unknown slug", async () => {
    const { app } = await boot();
    const res = await request(app).get("/api/sales/no-such-sale/status");
    expect(res.status).toBe(404);
    // The sale-resolver attaches a distinct message from the generic catch-all.
    expect(res.body).toEqual({ success: false, error: "Sale not found." });
  });

  it("sale-resolver 404 and the catch-all 404 have different error messages", async () => {
    const { app } = await boot();

    const catchAll = await request(app).get("/api/unknown-path");
    const resolver = await request(app).get("/api/sales/no-such-sale/status");

    expect(catchAll.body.error).toBe("Not found.");
    expect(resolver.body.error).toBe("Sale not found.");
    expect(catchAll.body.error).not.toBe(resolver.body.error);
  });
});

// ---------------------------------------------------------------------------
// Request body size limit (default: 8 kb from bodyLimit config)
// ---------------------------------------------------------------------------

describe("request body size limit — 8 kb default", () => {
  it("413 when the JSON body exceeds 8 kb", async () => {
    const { app } = await boot();
    // Build a JSON object whose serialised form is well over 8 192 bytes.
    const bigBody = { email: "a@b.com", pad: "x".repeat(10_000) };
    const res = await request(app)
      .post(`/api/sales/${SALE_SLUG}/order`)
      .send(bigBody);
    expect(res.status).toBe(413);
    expect(res.body.success).toBe(false);
  });

  it("202 for a body that is just under 8 kb", async () => {
    const { app } = await boot();
    // email (26 chars) + small pad keeps the serialised form under 8 192 bytes.
    const smallBody = { email: "buyer@example.com", pad: "x".repeat(100) };
    const res = await request(app)
      .post(`/api/sales/${SALE_SLUG}/order`)
      .send(smallBody);
    // The route itself validates email — a well-formed email still returns 202.
    expect(res.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON body
// ---------------------------------------------------------------------------

describe("malformed JSON body", () => {
  it("400 when Content-Type is application/json but the body is not valid JSON", async () => {
    const { app } = await boot();
    const res = await request(app)
      .post(`/api/sales/${SALE_SLUG}/order`)
      .set("Content-Type", "application/json")
      .send("this is { not: valid JSON }");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("400 for a truncated JSON payload", async () => {
    const { app } = await boot();
    const res = await request(app)
      .post(`/api/sales/${SALE_SLUG}/order`)
      .set("Content-Type", "application/json")
      .send('{"email": "buyer@example.com"'); // missing closing brace
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reserved "active" slug — not a real sale, never shadows the discovery route
// ---------------------------------------------------------------------------

describe("reserved slug 'active'", () => {
  it("GET /api/sales/active returns the discovery response, not a slug 404", async () => {
    const { app } = await boot();
    const res = await request(app).get("/api/sales/active");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, slug: SALE_SLUG });
  });

  it("GET /api/sales/active/status treats 'active' as a real slug lookup — returns 404", async () => {
    // There is no sale named "active"; the resolver returns 404.
    const { app } = await boot();
    const res = await request(app).get("/api/sales/active/status");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Sale not found." });
  });
});
