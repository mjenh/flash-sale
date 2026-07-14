// SSE endpoint tests through the REAL bootstrap() — tests never re-implement
// boot. Redis is the shared in-memory fake (now carrying the sale:events
// pub/sub bus) and Mongo is the shared model-ops fake. Streaming reads use
// the raw node:http helper (supertest buffers until the response ends —
// unusable for an open stream); supertest is still used where the request
// completes (the fail-closed 503).
//
// Coalescing under real timers stays deliberately coarse (strictly fewer
// frames than accepts + the final frame carries the fresh truth); the exact
// 250 ms math is pinned by fake-timer unit tests in sale-events.test.ts.
// Boundary-timer firing runs here on real short-delay timers (window
// boundaries ~150/400 ms after boot); the full boundary matrix (ceiling
// chunking, cancel, mid-window) is unit-tested in sale-events.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import request from "supertest";
import { pino, type Logger } from "pino";
import { bootstrap, type BootstrapOverrides } from "../src/bootstrap.ts";
import { SALE_SLUG } from "../src/adapters/mongo/seed.ts";
import { saleEventsChannel } from "../src/adapters/redis/events.ts";
import { createFakeRedis, type FakeRedis } from "./helpers/fake-redis.ts";
import { createFakeMongo, reserveSaleId } from "./helpers/fake-mongo.ts";
import { closeAllSse, frameData, openSse } from "./helpers/sse.ts";

const SALE_START = "2026-07-10T04:00:00Z";
const SALE_END = "2026-07-10T05:00:00Z";
const startMs = Date.parse(SALE_START);
const endMs = Date.parse(SALE_END);
const IN_WINDOW = startMs + 1000;
const START_ISO = "2026-07-10T04:00:00.000Z";
const END_ISO = "2026-07-10T05:00:00.000Z";

afterEach(async () => {
  await closeAllSse();
});

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

async function boot(opts: {
  nowMs?: number;
  clock?: () => number;
  stock?: string;
  env?: Record<string, string>;
}) {
  const mongo = createFakeMongo();
  const saleId = await reserveSaleId(mongo, SALE_SLUG);
  const fake: FakeRedis = createFakeRedis(opts.stock === undefined ? {} : { stock: opts.stock, saleId });
  const { lines, logger } = captureLogger();
  const overrides: BootstrapOverrides = {
    env: opts.env ?? {
      SALE_START_TIME: SALE_START,
      SALE_END_TIME: SALE_END,
      STOCK_QUANTITY: "100",
    },
    logger,
    clock: opts.clock ?? (() => opts.nowMs as number),
    createRedis: () => fake.client,
    connectRedis: vi.fn(async () => {}),
    disconnectRedis: vi.fn(async () => {}),
    connectMongoDb: vi.fn(async () => {}),
    disconnectMongoDb: vi.fn(async () => {}),
    mongoModelOps: mongo.ops,
  };
  const { app } = await bootstrap(overrides);
  return { fake, saleId, app, lines };
}

/** Drain the microtask/immediate queue so fire-and-forget publishes settle. */
const drain = () => new Promise((resolve) => setImmediate(resolve));

describe("GET /api/sale/events — stream contract", () => {
  it("responds 200 text/event-stream with an immediate snapshot status frame carrying the exact body", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "37" });
    const stream = await openSse(app);

    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toBe("text/event-stream");
    expect(stream.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(stream.headers["x-accel-buffering"]).toBe("no");

    const [snapshot] = await stream.waitForFrames(1);
    const body = {
      success: true,
      status: "active",
      stock: 37,
      startTime: START_ISO,
      endTime: END_ISO,
    };
    // Character-exact frame; fresh read at emit time (warm-seeded stock 37).
    expect(snapshot).toBe(`event: status\ndata: ${JSON.stringify(body)}\n\n`);
    expect(frameData(snapshot as string)).toEqual(body);
  });

  it("a SECOND connect receives its own snapshot — snapshot on every (re)connect, no replay", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "37" });
    const first = await openSse(app);
    await first.waitForFrames(1);

    const second = await openSse(app);
    const [snapshot] = await second.waitForFrames(1);
    expect(snapshot).toBe(first.frames()[0]);
  });
});

// Story 4.4 (AC4, AC5, AC6): the slug-scoped SSE route must be byte-for-byte
// identical to the v1.0 alias — both flow through the same broadcaster and
// resolve the same req.sale (forSlug() on the one valid slug vs.
// forActiveSale() on the alias mount), so their snapshots, live updates, and
// terminal frames must never diverge.
describe("GET /api/sales/:slug/events — identical to the v1.0 alias", () => {
  it("the connect-time snapshot is byte-for-byte identical to GET /api/sale/events", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "37" });

    const alias = await openSse(app, "/api/sale/events");
    const [aliasSnapshot] = await alias.waitForFrames(1);

    const scoped = await openSse(app, "/api/sales/flash-sale/events");
    const [scopedSnapshot] = await scoped.waitForFrames(1);

    expect(scopedSnapshot).toBe(aliasSnapshot);
    expect(frameData(scopedSnapshot as string)).toEqual({
      success: true,
      status: "active",
      stock: 37,
      startTime: START_ISO,
      endTime: END_ISO,
    });
  });

  it("a live order.accepted update reaches BOTH the alias and slug-scoped connections with the identical frame", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "3" });
    const alias = await openSse(app, "/api/sale/events");
    const scoped = await openSse(app, "/api/sales/flash-sale/events");
    await alias.waitForFrames(1);
    await scoped.waitForFrames(1);

    const res = await request(app).post("/api/sales/flash-sale/order").send({ email: "buyer@example.com" });
    expect(res.status).toBe(201);
    await drain();

    const aliasFrames = await alias.waitForFrames(2);
    const scopedFrames = await scoped.waitForFrames(2);
    expect(scopedFrames[1]).toBe(aliasFrames[1]);
    expect(frameData(scopedFrames[1] as string)).toEqual({
      success: true,
      status: "active",
      stock: 2,
      startTime: START_ISO,
      endTime: END_ISO,
    });
  });

  it("returns 404 for an unknown slug — never opens a stream", async () => {
    const { app } = await boot({ nowMs: IN_WINDOW, stock: "37" });
    const res = await request(app).get("/api/sales/nonexistent/events");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Sale not found." });
  });

  it("fails closed with the exact 503 envelope while Redis is down, same as the v1.0 alias", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "37" });
    fake.failing = true;
    const res = await request(app).get("/api/sales/flash-sale/events");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: "Service temporarily unavailable." });
  });
});

describe("live update path", () => {
  it("an accepted order publishes order.accepted and the stream receives the decremented truth", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "3" });
    const stream = await openSse(app);
    await stream.waitForFrames(1);

    const res = await request(app).post("/api/order").send({ email: "buyer@example.com" });
    expect(res.status).toBe(201);
    await drain();
    expect(fake.published).toEqual(["order.accepted"]);

    const frames = await stream.waitForFrames(2);
    expect(frameData(frames[1] as string)).toEqual({
      success: true,
      status: "active",
      stock: 2, // composed via the sale-status service from a fresh read
      startTime: START_ISO,
      endTime: END_ISO,
    });
  });

  it("draining stock to 0 publishes sale.sold_out exactly once and both open streams end on the identical sold_out frame", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "1" });
    const one = await openSse(app);
    const two = await openSse(app);
    await one.waitForFrames(1);
    await two.waitForFrames(1);

    const res = await request(app).post("/api/order").send({ email: "last@example.com" });
    expect(res.status).toBe(201);
    await drain();
    expect(fake.published).toEqual(["order.accepted", "sale.sold_out"]);
    expect(fake.published.filter((e) => e === "sale.sold_out")).toHaveLength(1);

    // order.accepted emits (leading edge), sale.sold_out is terminal and
    // emits immediately as the final frame — both frames compose AFTER the
    // decrement, so both carry the sold_out truth; every connection gets
    // identical frames (composed once).
    const framesOne = await one.waitForFrames(3);
    const framesTwo = await two.waitForFrames(3);
    expect(framesOne).toEqual(framesTwo);
    expect(frameData(framesOne.at(-1) as string)).toEqual({
      success: true,
      status: "sold_out",
      stock: 0,
      startTime: START_ISO,
      endTime: END_ISO,
    });
  });

  it("a rejected attempt (SOLD_OUT verdict at stock 0) publishes NOTHING", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "0" });
    const res = await request(app).post("/api/order").send({ email: "late@example.com" });
    expect(res.status).toBe(409);
    await drain();
    expect(fake.published).toEqual([]);
    expect(fake.calls.publish).toBe(0);
  });

  it("coalesces a burst: 5 accepted orders produce strictly fewer frames, and the LAST frame is the final truth", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "5" });
    const stream = await openSse(app);
    await stream.waitForFrames(1);

    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).post("/api/order").send({ email: `burst-${i}@example.com` });
      expect(res.status).toBe(201);
    }
    await drain();
    expect(fake.published.filter((e) => e === "order.accepted")).toHaveLength(5);

    // Generous real-timer wait (>= 2x the 250 ms window) — exact coalescing
    // math is pinned by the fake-timer unit tests.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const updates = stream.frames().slice(1);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates.length).toBeLessThan(5); // strictly fewer broadcasts than accepts
    expect(frameData(updates.at(-1) as string)).toEqual({
      success: true,
      status: "sold_out",
      stock: 0,
      startTime: START_ISO,
      endTime: END_ISO,
    });
  });
});

describe("fail closed", () => {
  it("new stream requests return the exact 503 envelope while Redis is down", async () => {
    const { fake, app } = await boot({ nowMs: IN_WINDOW, stock: "37" });
    fake.failing = true;
    // The request completes (no stream opens), so plain supertest works.
    const res = await request(app).get("/api/sale/events");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ success: false, error: "Service temporarily unavailable." });
  });

  it("mid-stream Redis loss: an emit's fresh read fails -> the stream ENDS and the failure is logged", async () => {
    const { fake, saleId, app, lines } = await boot({ nowMs: IN_WINDOW, stock: "37" });
    const stream = await openSse(app);
    await stream.waitForFrames(1);

    fake.failing = true;
    // failing=true blocks the bus too — inject the event at the subscription,
    // as if published just before the outage.
    fake.deliver(saleEventsChannel(saleId), "order.accepted");

    await stream.closed(); // the socket actually ends — not internal state
    expect(lines.some((line) => line.includes("sse broadcast failed"))).toBe(true);
  });

  it("subscriber connection loss closes open streams", async () => {
    const { fake, app, lines } = await boot({ nowMs: IN_WINDOW, stock: "37" });
    const stream = await openSse(app);
    await stream.waitForFrames(1);

    fake.emitSubscriberError(new Error("gone"));

    await stream.closed();
    expect(lines.some((line) => line.includes("subscriber connection lost"))).toBe(true);
  });

  it("publish failures never alter the HTTP outcome: the order still returns the exact 201 body, one failure reported", async () => {
    const { fake, app, lines } = await boot({ nowMs: IN_WINDOW, stock: "3" });
    fake.failingPublish = true;

    const res = await request(app).post("/api/order").send({ email: "buyer@example.com" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      success: true,
      email: "buyer@example.com",
      message: "Order successful.",
    });

    await drain();
    expect(fake.published).toEqual([]); // nothing got through
    const reported = lines.filter(
      (line) => line.includes("post-accept side effect failed") && line.includes("publish"),
    );
    expect(reported).toHaveLength(1);
  });
});

describe("window-boundary timers through boot", () => {
  it("boot before start publishes sale.started/sale.ended at the boundaries and streams the transitions", async () => {
    // Real short-delay timers: boundaries ~250/750 ms after boot (generous
    // gaps against event-loop jitter). The clock override is real time, so
    // armWindowTimers and the status composer agree.
    const now = Date.now();
    const { fake, app } = await boot({
      clock: () => Date.now(),
      stock: "37",
      env: {
        SALE_START_TIME: new Date(now + 250).toISOString(),
        SALE_END_TIME: new Date(now + 750).toISOString(),
        STOCK_QUANTITY: "100",
      },
    });
    const stream = await openSse(app);
    const [snapshot] = await stream.waitForFrames(1);
    expect((frameData(snapshot as string) as { status: string }).status).toBe("upcoming");

    await vi.waitFor(
      () => {
        expect(fake.published).toContain("sale.started");
      },
      { timeout: 2000 },
    );
    await vi.waitFor(
      () => {
        expect(fake.published).toContain("sale.ended");
      },
      { timeout: 2000 },
    );
    expect(fake.published.filter((e) => e === "sale.started")).toHaveLength(1);
    expect(fake.published.filter((e) => e === "sale.ended")).toHaveLength(1);

    const frames = await stream.waitForFrames(3);
    const statuses = frames.map((frame) => (frameData(frame) as { status: string }).status);
    expect(statuses[0]).toBe("upcoming");
    expect(statuses).toContain("active");
    expect(statuses.at(-1)).toBe("ended"); // terminal — always the final frame
  });

  it("boot after end publishes ZERO boundary events — future boundaries only; snapshot heals (negative space)", async () => {
    const { fake, app } = await boot({ nowMs: endMs + 60_000, stock: "12" });
    const stream = await openSse(app);
    const [snapshot] = await stream.waitForFrames(1);
    expect((frameData(snapshot as string) as { status: string }).status).toBe("ended");

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.published).toEqual([]);
    expect(fake.calls.publish).toBe(0);
  });
});
