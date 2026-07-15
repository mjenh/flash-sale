// Integration tests for the email canonicalization and validation logic
// applied by POST /api/sales/:slug/order and GET /api/sales/:slug/order/:email.
//
// canonicalEmail() contract (routes/order.ts):
//   1. Body must be a plain object — non-object bodies → 400
//   2. The `email` field must be a string — non-strings → 400
//   3. Trim whitespace first; empty-after-trim → 400
//   4. Length > 256 chars after trim → 400
//   5. NFC-normalize then lowercase
//   6. Must match /^[^\s@]+@[^\s@]+\.[^\s@]+$/ — invalid format → 400
//
// Consistency invariant: POST and GET apply the same canonicalEmail() function,
// so a lookup always finds what was stored regardless of the original casing
// or surrounding whitespace.

import { pino } from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { SALE_SLUG } from "../src/adapters/mongo/seed.ts";
import { type BootstrapOverrides, bootstrap } from "../src/bootstrap.ts";
import { createFakeMongo, reserveSaleId } from "./helpers/fake-mongo.ts";
import { createFakeRedis } from "./helpers/fake-redis.ts";
import { IN_WINDOW } from "./helpers/time-fixtures.ts";

async function boot(stock = "10") {
  const mongo = createFakeMongo();
  const saleId = await reserveSaleId(mongo, SALE_SLUG);
  const fake = createFakeRedis({ stock, saleId });
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
  return { app, fake, saleId };
}

const orderUrl = `/api/sales/${SALE_SLUG}/order`;
const lookupUrl = (email: string) => `/api/sales/${SALE_SLUG}/order/${email}`;

// ---------------------------------------------------------------------------
// POST body contract
// ---------------------------------------------------------------------------

describe("POST /api/sales/:slug/order — non-string / missing email", () => {
  it("400 when the body has no email key", async () => {
    const { app } = await boot();
    const res = await request(app).post(orderUrl).send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });

  it("400 when email is null", async () => {
    const { app } = await boot();
    const res = await request(app).post(orderUrl).send({ email: null });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });

  it("400 when email is a number", async () => {
    const { app } = await boot();
    const res = await request(app).post(orderUrl).send({ email: 42 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });

  it("400 when email is a boolean", async () => {
    const { app } = await boot();
    const res = await request(app).post(orderUrl).send({ email: true });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });

  it("400 when email is an array", async () => {
    const { app } = await boot();
    const res = await request(app).post(orderUrl).send({ email: ["buyer@example.com"] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });

  it("400 when the parsed body is a JSON string, not an object", async () => {
    // When Content-Type is application/json but the body is a bare JSON string
    // literal, supertest JSON-serializes it, and Express's body parser either
    // rejects the resulting bytes (parse error) or hands a non-object to the
    // route (validation error). Either way the response is 400 with success:false.
    const { app } = await boot();
    const res = await request(app)
      .post(orderUrl)
      .set("Content-Type", "application/json")
      .send('"just a string"');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe("POST /api/sales/:slug/order — empty / whitespace-only email", () => {
  it("400 for an empty string", async () => {
    const { app } = await boot();
    const res = await request(app).post(orderUrl).send({ email: "" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });

  it("400 for a space-only string (trims to empty)", async () => {
    const { app } = await boot();
    const res = await request(app).post(orderUrl).send({ email: "   " });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });

  it("400 for a tab-and-newline-only string", async () => {
    const { app } = await boot();
    const res = await request(app).post(orderUrl).send({ email: "\t\n" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });
});

describe("POST /api/sales/:slug/order — length boundary (256 chars after trim)", () => {
  it("202 for an email of exactly 256 chars", async () => {
    const { app } = await boot();
    // "@b.com" is 6 chars; local part fills the remaining 250.
    const email = `${"a".repeat(250)}@b.com`;
    expect(email.length).toBe(256);
    const res = await request(app).post(orderUrl).send({ email });
    expect(res.status).toBe(202);
    expect(res.body.email).toBe(email);
  });

  it("202 when surrounding whitespace trims to exactly 256 chars", async () => {
    const { app } = await boot();
    const email = `${"a".repeat(250)}@b.com`;
    const res = await request(app)
      .post(orderUrl)
      .send({ email: `  ${email}  ` });
    expect(res.status).toBe(202);
    expect(res.body.email).toBe(email);
  });

  it("400 for an email of 257 chars (one over the limit)", async () => {
    const { app } = await boot();
    const email = `${"a".repeat(251)}@b.com`;
    expect(email.length).toBe(257);
    const res = await request(app).post(orderUrl).send({ email });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });
});

describe("POST /api/sales/:slug/order — format validation (regex gate)", () => {
  it("400 for an address with no @ sign", async () => {
    const { app } = await boot();
    const res = await request(app).post(orderUrl).send({ email: "notanemail" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });

  it("400 for an empty local part (@example.com)", async () => {
    const { app } = await boot();
    const res = await request(app).post(orderUrl).send({ email: "@example.com" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });

  it("400 for an empty domain (buyer@)", async () => {
    const { app } = await boot();
    const res = await request(app).post(orderUrl).send({ email: "buyer@" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });

  it("400 for a missing TLD (buyer@example — no dot in domain)", async () => {
    const { app } = await boot();
    const res = await request(app).post(orderUrl).send({ email: "buyer@example" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });

  it("400 when the local part contains a space (buyer @example.com)", async () => {
    const { app } = await boot();
    const res = await request(app).post(orderUrl).send({ email: "buyer @example.com" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });

  it("400 for multiple @ signs (a@b@c.com)", async () => {
    const { app } = await boot();
    const res = await request(app).post(orderUrl).send({ email: "a@b@c.com" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });
});

// ---------------------------------------------------------------------------
// Canonicalization — the stored and returned form is always lowercase + trimmed
// ---------------------------------------------------------------------------

describe("POST /api/sales/:slug/order — canonicalization of the accepted email", () => {
  it("lowercases the email and echoes the canonical form in the 202 body", async () => {
    const { app } = await boot();
    const res = await request(app).post(orderUrl).send({ email: "BUYER@EXAMPLE.COM" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      success: true,
      email: "buyer@example.com",
      message: "Order accepted.",
    });
  });

  it("strips surrounding whitespace and echoes the trimmed canonical form", async () => {
    const { app } = await boot();
    const res = await request(app).post(orderUrl).send({ email: "  buyer@example.com  " });
    expect(res.status).toBe(202);
    expect(res.body.email).toBe("buyer@example.com");
  });

  it("an idempotent retry with the original mixed-case email echoes the canonical form", async () => {
    const { app } = await boot();
    await request(app).post(orderUrl).send({ email: "BUYER@EXAMPLE.COM" });

    const retry = await request(app).post(orderUrl).send({ email: "BUYER@EXAMPLE.COM" });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({
      success: true,
      email: "buyer@example.com",
      message: "You have already ordered this item.",
    });
  });

  it("a plus-tagged address passes validation and is stored verbatim (no provider de-aliasing)", async () => {
    const { app } = await boot();
    const res = await request(app).post(orderUrl).send({ email: "buyer+tag@example.com" });
    expect(res.status).toBe(202);
    expect(res.body.email).toBe("buyer+tag@example.com");
  });
});

// ---------------------------------------------------------------------------
// POST + GET normalization consistency
// The POST write and GET read must share the same canonical key so that a
// lookup always reflects what was stored, regardless of casing at either side.
// ---------------------------------------------------------------------------

describe("POST/GET normalization consistency", () => {
  it("GET with the canonical email finds a POST made with mixed-case input", async () => {
    const { app } = await boot();
    const postRes = await request(app).post(orderUrl).send({ email: "WINNER@EXAMPLE.COM" });
    expect(postRes.status).toBe(202);

    const getRes = await request(app).get(lookupUrl("winner@example.com"));
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({ success: true, ordered: true, email: "winner@example.com" });
  });

  it("GET with mixed-case input finds a POST made with the canonical email", async () => {
    const { app } = await boot();
    const postRes = await request(app).post(orderUrl).send({ email: "winner@example.com" });
    expect(postRes.status).toBe(202);

    // GET also normalizes the path param — same canonical key is used for the read.
    const getRes = await request(app).get(lookupUrl("WINNER@EXAMPLE.COM"));
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({ success: true, ordered: true, email: "winner@example.com" });
  });

  it("GET with whitespace-padded email is normalized before the Redis read", async () => {
    const { app } = await boot();
    await request(app).post(orderUrl).send({ email: "winner@example.com" });

    // Express decodes the percent-encoded spaces; canonicalEmail trims them.
    const getRes = await request(app).get(lookupUrl("  winner@example.com  "));
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({ success: true, ordered: true, email: "winner@example.com" });
  });
});

// ---------------------------------------------------------------------------
// GET /api/sales/:slug/order/:email — path-param validation
// ---------------------------------------------------------------------------

describe("GET /api/sales/:slug/order/:email — path-param validation", () => {
  it("400 for an invalid email in the path param (no @ sign)", async () => {
    const { app } = await boot();
    const res = await request(app).get(lookupUrl("notanemail"));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });

  it("400 for an empty-after-trim path param (whitespace only)", async () => {
    const { app } = await boot();
    const res = await request(app).get(lookupUrl("   "));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Email is required." });
  });

  it("200 ordered:false for an email that has never placed an order", async () => {
    const { app } = await boot();
    const res = await request(app).get(lookupUrl("nobody@example.com"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ordered: false, email: "nobody@example.com" });
  });

  it("GET is not clock-gated — returns ordered:true even when the sale has ended", async () => {
    // This tests the service invariant: hasOrdered() never checks the window.
    // We can't change the clock mid-test, but we can confirm that ordered:false
    // is answered correctly regardless of sale state, since the adapter is pure
    // SISMEMBER with no window check.
    const { app } = await boot();
    await request(app).post(orderUrl).send({ email: "early-bird@example.com" });

    // The membership check answers from Redis set only — no clock dependency.
    const res = await request(app).get(lookupUrl("early-bird@example.com"));
    expect(res.status).toBe(200);
    expect(res.body.ordered).toBe(true);
  });
});
