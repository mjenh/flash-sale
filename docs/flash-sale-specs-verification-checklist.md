# Flash Sale System — Verification Audit Report

**Audited by:** Lead QA Engineer / Technical Auditor (Claude)
**Date:** 2026-07-16
**Checklist source:** `docs/flash-sale-verification-checklist.md`
**Codebase:** `/Users/mjhagonoy/workspace/github.com/mjenh/flash-sale`

---

## 1. Audit Summary Dashboard

- **Total Checklist Items:** 47
- **Passed (PASS):** 47 (100%)
- **Failed (FAIL):** 0 (0%)
- **Audit Status:** COMPLETE ✅

---

## 2. Checklist Verification Report

---

### Core Functional Requirements — Flash Sale Period

### [x] Sale has a **configurable** start time and end time

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/adapters/mongo/sale-bootstrap.ts` (Lines 43–49)
  - *Code Snippet:* `startTime: s.startTime, endTime: s.endTime, stockQuantity: s.stockQuantity`
- **Reasoning:** Sale timing is stored in MongoDB (`db/data/sales.json`), seeded via `db/scripts/seed-db.ts`, and read at boot by `mongoSaleBootstrapOps.listAllSales()`. Values are not hardcoded or env-var-only; they are DB-provisioned and fully changeable without code modification.

---

### [x] Purchase attempts **before** the start time are rejected (status: upcoming)

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/services/sale-status.ts` (Lines 55–57); `server/src/services/order.ts` (Lines 83–87)
  - *Code Snippet:* `if (now < window.startMs) { status = "upcoming"; }` / `const inWindow = now >= window.startMs && now < window.endMs; if (!inWindow) { return (await orders.hasOrdered(...)) ? { outcome: "already" } : { outcome: "inactive" }; }`
- **Reasoning:** `createSaleStatusService` returns `"upcoming"` before the window. The order service returns `{ outcome: "inactive" }` (mapped to `409 "Sale is not active."` at the route) for any non-holder outside the window. Unit-tested in `sale-status.test.ts` ("reports upcoming before the window") and `order-service.test.ts` ("before start … -> inactive").

---

### [x] Purchase attempts **after** the end time are rejected (status: ended)

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/services/sale-status.ts` (Lines 58–60); `server/src/services/order.ts` (Lines 83–87)
  - *Code Snippet:* `} else if (now >= window.endMs) { status = "ended"; }`
- **Reasoning:** The window is `[start, end)` — `now >= window.endMs` yields `"ended"`. Order attempts return `inactive`. The service test asserts "boundary: exactly end is ended, even with stock remaining". The stress harness's window phase confirms 409 rejection after the sale closes.

---

### [x] Purchases are only accepted **within** the active window

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/services/order.ts` (Lines 83–90)
  - *Code Snippet:* `const inWindow = now >= window.startMs && now < window.endMs; if (!inWindow) { return ...; } const { verdict, remaining } = await orders.attempt(saleId, email);`
- **Reasoning:** The Lua script (the only Redis writer) is invoked exclusively inside the `inWindow` guard. Outside the window, the script never runs — the route returns `inactive` without touching Redis stock.

---

### Core Functional Requirements — Single Product, Limited Stock

### [x] System sells exactly **one product type**

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/adapters/mongo/sale-bootstrap.ts` (Lines 55–59)
  - *Code Snippet:* `async getSaleProduct(saleId: string): Promise<{ productId: string; flashSalePrice: number } | null> { const sp = await SaleProduct.findOne({ saleId }).lean(); ...`
- **Reasoning:** `getSaleProduct` fetches at most one product per sale (`findOne`). The architecture doc states "v1 has exactly one product per sale." The seed data provisions exactly one SaleProduct per sale. The `GET /api/sales/:slug` endpoint returns a `products` array, but the seeder and bootstrap logic enforce one product per sale.

---

### [x] Product has a **predefined, configurable** stock quantity

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/adapters/mongo/sale-bootstrap.ts` (Line 46); `db/data/sales.json`
  - *Code Snippet:* `stockQuantity: s.stockQuantity` (read from MongoDB Sale document)
- **Reasoning:** `stockQuantity` is defined in `db/data/sales.json`, provisioned into MongoDB via `db/scripts/seed-db.ts`, and read at boot. The README explains: "Changing `stockQuantity` in `db/data/sales.json`... then re-provisioning resets the quantity."

---

### [x] Stock **never goes negative** (no overselling)

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/adapters/redis/order.lua` (Lines 33–35); `server/src/adapters/redis/orders.ts` (Lines 97–99)
  - *Code Snippet:* `if stock <= 0 then return { 'SOLD_OUT', stock } end` (Lua guard); `if (remaining < 0) { throw new RedisUnavailableError(...) }` (TS guard)
- **Reasoning:** The Lua script only executes `DECR` after confirming `stock > 0`. The `parseDecision` function in `orders.ts` adds a second defense — any external mutation that produces a negative remaining triggers a `RedisUnavailableError` (fail-closed), never a silent negative propagation.

---

### [x] Sale reports **sold out** once stock reaches zero

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/services/sale-status.ts` (Lines 61–62); `server/src/services/order.ts` (Lines 118–122)
  - *Code Snippet:* `status = remaining > 0 ? "active" : "sold_out";` / `if (remaining === 0) { void events.publish("sale.sold_out", saleId)... }`
- **Reasoning:** Inside the window, `sold_out` is returned when stock reaches zero. The `sale.sold_out` event is published exactly once — by the request whose Lua `DECR` returned `0`. Tested in `sale-status.test.ts` ("reports sold_out inside the window at stock 0") and `order-service.test.ts` ("Scenario D: stock exactly 1 → ... sale.sold_out fires exactly once").

---

### Core Functional Requirements — One Item Per User

### [x] Each user can purchase **at most one** unit

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/adapters/redis/order.lua` (Lines 30–32)
  - *Code Snippet:* `if redis.call('SISMEMBER', ordersKey, ARGV[1]) == 1 then return { 'ALREADY', stock } end`
- **Reasoning:** Every purchase attempt atomically checks the buyer's email against the `orders:{saleId}:users` Redis set. A second attempt by the same email returns `ALREADY` without decrementing stock. The email is NFC-normalized and case-folded before reaching Redis, so variant forms collapse to the same key.

---

### [x] Duplicate/repeat purchase attempts by the same user are rejected with a clear "already purchased" result

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/routes/order.ts` (Lines 84–86)
  - *Code Snippet:* `case "already": res.status(200).json({ success: true, email, message: "You have already ordered this item." });`
- **Reasoning:** The `ALREADY` verdict maps to HTTP 200 with `"You have already ordered this item."` — distinct from 202 (success), 409 sold out, and 409 inactive. The order service test verifies "maps ALREADY -> already".

---

### [x] Rule holds under **concurrent** duplicate requests from the same user

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `stress/k6-order.js` (Lines 36, 72–95 — `spam` scenario); `server/src/adapters/redis/order.lua` (Lines 30–37)
  - *Code Snippet:* `const SPAM_EMAIL = \`spam-${RUN_TAG}@example.com\`` — 20 VUs share one email; threshold `spam_wins_202 <= 1`
- **Reasoning:** The Lua script executes as a single atomic unit inside Redis (single-threaded). Concurrent duplicate requests see the same atomic SISMEMBER — the first to complete adds the member; all subsequent ones see `SISMEMBER == 1` and return `ALREADY`. The k6 spam scenario proves this under concurrent load.

---

### Core Functional Requirements — API Server

### [x] Endpoint to **check sale status** (upcoming / active / ended / sold out)

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/routes/sale.ts` (Lines 21–31)
  - *Code Snippet:* `router.get("/status", async (req, res) => { ... res.json(await saleStatus.getStatus(sale._id, windowFromSale(sale))); })`
- **Reasoning:** `GET /api/sales/:slug/status` returns `{ success, status, stock, startTime, endTime }` where `status` is one of `"upcoming" | "active" | "ended" | "sold_out"`. Covered by integration tests in `sale-events-endpoint.test.ts` and `sales-endpoint.test.ts`.

---

### [x] Endpoint for a user to **attempt a purchase**

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/routes/order.ts` (Lines 65–95)
  - *Code Snippet:* `router.post("/", async (req: Request, res: Response) => { ... const result = await orderService.attempt(...); })`
- **Reasoning:** `POST /api/sales/:slug/order` accepts a JSON body `{ email }`, runs the atomic order attempt, and returns `202 accepted`, `200 already`, `409 sold_out`, `409 inactive`, or `400 invalid email`.

---

### [x] Endpoint for a user to **check if they secured an item**

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/routes/order.ts` (Lines 106–123)
  - *Code Snippet:* `router.get("/:email", async (req: Request, res: Response) => { ... const ordered = await orderService.hasOrdered(sale._id, email); res.status(200).json({ success: true, ordered, email }); })`
- **Reasoning:** `GET /api/sales/:slug/order/:email` returns `{ success: true, ordered: boolean, email }`. This endpoint is clock-agnostic and answered from Redis membership — honest before, during, and after the window.

---

### [x] API returns clear, distinct responses for each outcome (success, already purchased, sold out, sale not active)

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/routes/order.ts` (Lines 81–94)
  - *Code Snippet:*
    ```
    case "created":  res.status(202).json({ success: true,  message: "Order accepted." });
    case "already":  res.status(200).json({ success: true,  message: "You have already ordered this item." });
    case "sold_out": res.status(409).json({ success: false, error: "Item is sold out." });
    case "inactive": res.status(409).json({ success: false, error: "Sale is not active." });
    ```
- **Reasoning:** Four fully distinct HTTP status codes (202, 200, 409, 409) with distinct `message`/`error` strings. Even the two 409s carry different error strings. The architecture doc's response table (`docs/architecture.md` §3.3) documents the full response contract.

---

### [x] Built with **Node.js** using Express, Fastify, Nest.js, or native `http`

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/app.ts` (Lines 1–5)
  - *Code Snippet:* `import express, { type Express, ... } from "express";`
- **Reasoning:** The server uses Express 5 on Node.js 24 with native TypeScript type stripping (no bundler). Confirmed in README tech stack table: "API: Express 5 · TypeScript."

---

### Core Functional Requirements — Simple Frontend

### [x] Displays the **current sale status**

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `client/src/pages/SalePage.tsx` (Lines 176–177); `client/src/components/SaleStatusZone.tsx`
  - *Code Snippet:* `<SaleStatusZone body={body} channel={channel} />`
- **Reasoning:** `useSaleStatus` retrieves live status via SSE (with poll fallback). `SaleStatusZone` renders the current `status` (upcoming / active / ended / sold_out) with stock count and channel health indicators.

---

### [x] Field to enter a **user identifier** (username/email)

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `client/src/pages/SalePage.tsx` (Lines 211–221)
  - *Code Snippet:* `<input id="email" type="email" inputMode="email" name="email" placeholder="you@example.com" value={email} onChange={...} />`
- **Reasoning:** A labeled `type="email"` input with `placeholder="you@example.com"` is the sole identifier field. The label reads "Who's buying?".

---

### [x] **"Buy Now"** button to attempt a purchase

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `client/src/pages/SalePage.tsx` (Lines 246–257)
  - *Code Snippet:* `<button type="submit" className="... buy-now ..." disabled={!canBuy && !processing} aria-busy={processing}>Buy Now</button>`
- **Reasoning:** A `type="submit"` button labeled "Buy Now" is present inside a `<form>` that calls `submit(email)` on submission, which invokes `placeOrder` via `useOrder`.

---

### [x] Shows feedback: **success**, **already purchased**, and **ended / sold out**

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `client/src/components/VerdictPanel.tsx` (Lines 15–17, 36–44)
  - *Code Snippet:*
    ```
    export const SUCCESS_FRAME = "It's yours!";
    export const ALREADY_FRAME = "All set — your order from today is safe.";
    case "sold_out": return SOLD_OUT_FRAME;
    case "inactive": return saleState === "upcoming" ? upcomingFrame(...) : ENDED_FRAME;
    ```
- **Reasoning:** `VerdictPanel` renders all four outcomes: success ("It's yours!"), already ordered ("All set — your order from today is safe."), sold out, and sale ended/upcoming. Each has a distinct `accent` class (`success` or `reject`).

---

### [x] Built with **React**

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `client/src/pages/SalePage.tsx` (Line 13)
  - *Code Snippet:* `import { useEffect, useState } from "react";`
- **Reasoning:** The frontend is React 19 + Vite, as documented in the README ("React 19 · Vite · nginx") and evidenced by all client source files using React hooks and JSX.

---

### Core Functional Requirements — System Diagram

### [x] Architecture diagram showing main components and their interactions

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `README.md` (Lines 30–63); `docs/architecture.md` (Lines 19–52)
- **Reasoning:** A Mermaid `flowchart LR` diagram shows all major components (Browser, Nginx, Express API routes/services/broadcaster, Redis decision/stream/pubsub, Worker, MongoDB) and every material interaction (SPA, /api proxy, SSE, EVALSHA atomic script, XADD, XREADGROUP, bulkWrite, XACK, PUBLISH, SUBSCRIBE, cold-start rebuild).

---

### [x] Diagram included in the `README.md`

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `README.md` (Lines 30–63)
  - *Code Snippet:* ` ```mermaid flowchart LR Browser["Browser<br/>React 19 SPA (Vite)"] ... ``` `
- **Reasoning:** The Mermaid diagram is embedded directly in `README.md` under the "Architecture" section, not only in a separate doc.

---

### [x] Design choices are justified in writing

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `README.md` (Lines 79–95, trade-offs table); `docs/architecture.md` §11
  - *Code Snippet:* Table columns: Decision | Buys | Costs — e.g., "One atomic Lua script | No oversell / one-per-user by construction | Hot-path logic in Lua, not TypeScript"
- **Reasoning:** The README has a structured "Key trade-offs" table with 8 entries, each documenting what the decision buys and what it costs. The "Known limitations" section is equally candid. `docs/architecture.md` §11 provides extended reasoning on every trade-off and named alternatives.

---

### Non-Functional Requirements — High Throughput & Scalability

### [x] Designed to handle a large number of **concurrent requests**

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/adapters/redis/order.lua`; `stress/k6-order.js` (Lines 50–60)
  - *Code Snippet:* `vus: VUS, iterations: ATTEMPTS, maxDuration: "5m"` — defaults 500 VUs, 5,000 iterations
- **Reasoning:** The single atomic Lua script eliminates application-level locking, making order attempts as concurrent as Redis can serve them. No DB write is on the hot path. The stress test proves the system holds up under 500 concurrent VUs making 5,000 attempts.

---

### [x] Bottlenecks identified and mitigated (e.g., queue, cache, atomic ops)

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `README.md` (Lines 85–95); `server/src/worker/order-worker.ts`
  - *Code Snippet:* "Stateless API, scale by widening the tier | Add instances freely without weakening the guarantee | One Redis primary is the shared throughput ceiling"
- **Reasoning:** The Redis single-primary bottleneck is explicitly identified. Mitigations documented: write-behind queue (Redis Stream + worker) decouples MongoDB writes; atomic Lua script eliminates row-locking; stateless API allows horizontal scaling. The architecture doc §11 expands on when and how to revisit each.

---

### [x] Design can scale horizontally (stateless services / shared store)

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `README.md` (Lines 93–94); `docker-compose.yml`
  - *Code Snippet:* "Stateless API, scale by widening the tier — Add instances freely without weakening the guarantee"
- **Reasoning:** The API tier holds no per-instance state. All shared mutable state lives in Redis (decision keys, stream) and MongoDB (audit). Multiple API replicas can run against the same Redis+Mongo without coordination. The compose worker uses `WORKER_CONSUMER_ID` (defaulting to `worker-<hostname>`) so multiple worker replicas each maintain their own PEL without collision.

---

### Non-Functional Requirements — Robustness & Fault Tolerance

### [x] Handles service crashes / restarts without data corruption

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/bootstrap.ts` (Lines 202–219); `server/src/adapters/redis/reconcile.ts`
  - *Code Snippet:* `if (await reconciler.hasStockKey(saleId)) { /* Warm start: surviving Redis state is authoritative */ } else { const emails = await saleBootstrap.listConfirmedOrderEmails(saleId); ... await reconciler.rebuild(emails, remaining, saleId); }`
- **Reasoning:** On cold start (Redis flushed/restarted), the boot sequence rebuilds Redis from MongoDB confirmed orders. The stock key is written last in `rebuild()` so an interrupted rebuild leaves the sentinel absent and triggers a clean retry on next boot. The write-behind worker uses PEL re-delivery (`readPending()` before `readBatch()`) so unACKed messages survive a worker crash.

---

### [x] Handles network issues gracefully (timeouts, retries where appropriate)

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/adapters/redis/orders.ts` (Lines 62–77); `server/src/worker/order-worker.ts` (Lines 47–84); `client/src/hooks/useSaleStatus.ts` (Lines 296–343)
  - *Code Snippet (server):* `raced(promise, timeoutMs)` wraps every Redis command; `RedisUnavailableError` surfaced as 503. Worker: `backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)` (500ms → 30s cap). Client: exponential reconnect backoff + 40s watchdog.
- **Reasoning:** Every Redis command is bounded by `redisCommandTimeoutMs`. Timeouts surface as 503 (fail-closed). The worker backs off exponentially on MongoDB outage without losing messages. The client hooks reconnect with jittered exponential backoff and fall back to HTTP polling when SSE is down.

---

### [x] No lost or double-counted purchases on partial failure

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/adapters/redis/order.lua` (Lines 36–37); `server/src/adapters/mongo/bulk-audit.ts`; MongoDB `Order` model (compound unique index)
  - *Code Snippet:* Lua: `redis.call('SADD', ordersKey, ARGV[1])` + `redis.call('DECR', stockKey)` — atomic, no partial state possible. Worker ACKs only after MongoDB confirms. Mongo `Order` has `{ saleId, email }` unique index as defense-in-depth.
- **Reasoning:** SADD and DECR are atomic — no partial failure between them. The write-behind worker holds messages in the PEL until MongoDB confirms, preventing audit loss on worker crash (at-least-once delivery). The MongoDB unique compound index prevents phantom duplicate audit records if a message is re-delivered. The known audit-under-count window (gap between Lua OK and XADD) is documented but does not affect the Redis truth (buyer's slot is never lost).

---

### Non-Functional Requirements — Concurrency Control

### [x] **Prevents overselling** under concurrent load

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/adapters/redis/order.lua` (Lines 33–37); `stress/verify.ts` (Lines 98–108)
  - *Code Snippet:* `if stock <= 0 then return { 'SOLD_OUT', stock } end redis.call('SADD', ...) return { 'OK', redis.call('DECR', ...) }` / verify: `pass: accepted === target` (exact equality, not ≤)
- **Reasoning:** The Lua script is the sole writer; Redis runs it single-threaded. No concurrent request can interleave between the stock check and the DECR. The stress verifier asserts an exact equality (`SCARD == stockQuantity`) — under-acceptance fails as loudly as oversell.

---

### [x] Race conditions handled (atomic decrement / locking / single-writer / transaction)

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/adapters/redis/order.lua` (header comment, Lines 1–4); `server/src/adapters/redis/orders.ts` (Lines 130–162)
- **Reasoning:** "Redis runs scripts single-threaded — nothing interleaves." The Lua script is registered via `SCRIPT LOAD` at boot and invoked via `EVALSHA`, with automatic `EVAL` fallback on `NOSCRIPT`. There is no application-level lock — atomicity is guaranteed by Redis's single-threaded script execution model.

---

### [x] "One item per user" enforced atomically alongside stock decrement

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `server/src/adapters/redis/order.lua` (Lines 30–37)
  - *Code Snippet:* `if redis.call('SISMEMBER', ordersKey, ARGV[1]) == 1 then return { 'ALREADY', stock } end ... redis.call('SADD', ordersKey, ARGV[1]) return { 'OK', redis.call('DECR', stockKey) }`
- **Reasoning:** SISMEMBER, SADD, and DECR all execute inside one atomic Lua script. There is no window between the membership check and the stock decrement where a concurrent request could race in and allow double-ordering or overselling.

---

### Testing Requirements

### [x] **Unit tests** for core business logic (period, stock, per-user rule)

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *Files:* `server/test/order-service.test.ts`; `server/test/sale-status.test.ts`; `server/test/order-script.test.ts`
- **Reasoning:** `order-service.test.ts` covers all window boundary cases (before start, at start, inside window, at end, after end), all verdict mappings (OK/ALREADY/SOLD_OUT), and fire-and-forget side effects. `sale-status.test.ts` covers all four status states with exact boundary instants. `order-script.test.ts` pins the Lua script's command shape, mutation ordering, and fail-closed behavior. All tests use injected clocks and fakes — zero I/O.

---

### [x] **Integration tests** for API endpoints

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *Files:* `server/test/app.test.ts`; `server/test/sales-endpoint.test.ts`; `server/test/order-audit-restart.test.ts`; `server/test/sale-events-endpoint.test.ts`
- **Reasoning:** `app.test.ts` tests the Express pipeline (error middleware, 404s, 503 for Redis-down). `sales-endpoint.test.ts` tests all slug-scoped endpoints through real `bootstrap()` with in-memory Redis/Mongo fakes (Supertest requests). `order-audit-restart.test.ts` covers the warm/cold boot lifecycle through real bootstrap. `sale-events-endpoint.test.ts` covers the SSE endpoint.

---

### [x] **Stress test** simulating high concurrent purchase volume

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *Files:* `stress/k6-order.js`; `stress/run.ts`
  - *Code Snippet:* `primary: { executor: "shared-iterations", vus: VUS, iterations: ATTEMPTS, maxDuration: "5m" }` — defaults 500 VUs × 5,000 unique emails
- **Reasoning:** The k6 script drives genuine concurrent load: 500 VUs share 5,000 iterations (unique buyer emails). The `run.ts` orchestrator manages the full stop→reset→start→k6→verify→window-phase cycle, making the harness repeatable and self-contained.

---

### [x] Stress test **proves no overselling** (sold count ≤ stock)

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `stress/verify.ts` (Lines 96–108)
  - *Code Snippet:* `{ name: "accepted orders (SCARD) == min(API stockQuantity, attempts)", pass: accepted === target, ... note: oversell ? "OVERSOLD — the one inviolable invariant is broken" : ... }`
- **Reasoning:** The verifier reads `SCARD orders:{saleId}:users` (the authoritative Redis count) and asserts it equals exactly `min(apiStockQuantity, attempts)` — an equality check, not merely ≤. Over-acceptance and under-acceptance both hard-fail. The stock basis is the API's own seeded `sales.stockQuantity`, never the harness's configured value.

---

### [x] Stress test **proves one-per-user** holds under load

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `stress/k6-order.js` (Lines 72–95); `stress/verify.ts` (Lines 109–114)
  - *Code Snippet:* k6: `const spamWins = new Counter("spam_wins_202"); ... thresholds: { "spam_wins_202": ["count<=1"] }` / verify: `{ name: "distinct emails == confirmed (Mongo) orders", pass: distinctEmails === orders }`
- **Reasoning:** The `spam` k6 scenario fires 20 concurrent requests with one shared email and asserts `spam_wins_202 <= 1`. The verifier additionally cross-checks that `DISTINCT email` in confirmed MongoDB orders equals the order count, catching any phantom duplicates.

---

### [x] Results are captured and explainable

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *Files:* `stress/run.ts` (Lines 472–481); `stress/verify.ts` (Lines 156–163); `stress/report.ts`
  - *Code Snippet:* `console.log(\`${p.ok ? "PASS" : "FAIL"}  ${p.name}...\`); ... console.log(failed.length === 0 ? "\nPASS — the fairness claim holds." : ...)`
- **Reasoning:** The harness prints a phase-by-phase PASS/FAIL summary to stdout. `verify.ts` formats each assertion with expected vs. actual values and explanatory notes. k6 writes `stress/.out/k6-summary.json` with counters. `stress/report.ts` generates an HTML report. The README's "Expected outcome" section shows the exact expected printout.

---

### Deliverables

### [x] Source code in a Git repository

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *Path:* Repository root at `github.com/mjenh/flash-sale` with `.git/` directory present.
- **Reasoning:** The codebase resides in a Git repository (path is under `github.com/`, `.git/` directory is present at the root).

---

### [x] `README.md` explaining design choices and trade-offs

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `README.md` (Lines 64–96, 356–408 Known Limitations, 410–452 Roadmap)
- **Reasoning:** The README covers: tech stack rationale, key trade-offs table (8 entries with Buy/Cost analysis), known limitations with accepted reasoning, and a roadmap. `docs/architecture.md` provides extended §11 trade-offs discussion. Together they give a thorough written justification of every significant design decision.

---

### [x] System diagram included in README

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `README.md` (Lines 30–63)
- **Reasoning:** A Mermaid `flowchart LR` diagram is directly embedded in `README.md` under the "Architecture" heading. It is not a link to a separate file — it is inline in the README itself.

---

### [x] Instructions to build/run **server**, **frontend**, and **tests**

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `README.md` (Lines 97–214, Quick Start / Development / Build & run sections); `CLAUDE.md` (Commands section)
- **Reasoning:** `make deploy` (one-command full stack), `npm run dev` (three-process dev loop), `npm test` (Vitest across workspaces), `npm run typecheck` (strict TS check), per-workspace commands, and Docker Compose direct commands are all documented with explanations of what each does.

---

### [x] Instructions to run **stress tests** + summary of expected outcome

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `README.md` (Lines 222–272, "Proving it" and "Stress configuration" sections)
  - *Code Snippet:* `npm run stress  # or: make stress` with expected output block showing phase-by-phase PASS/FAIL summary
- **Reasoning:** The README documents the exact command, prerequisites (Docker), what each phase does, the configurable parameters (`ATTEMPTS`, `VUS`, `STOCK_QUANTITY`), and the expected terminal output for a passing run.

---

### Code Quality

### [x] Clean, well-structured, maintainable code

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *Files:* `server/src/services/order.ts`; `server/src/routes/order.ts`; `server/src/adapters/redis/orders.ts`
- **Reasoning:** The codebase enforces strict one-way layer dependencies (routes → services → adapters). Services are framework-free (no Express/Redis/Mongoose imports). The single composition root (`bootstrap.ts`) wires all dependencies. `erasableSyntaxOnly: true` in `tsconfig.json` bans `enum` and `namespace` — only const maps. Every non-trivial module opens with a block comment explaining invariants, parameter semantics, and design decisions. File and function naming is consistent throughout.

---

### [x] Sensible engineering trade-offs, explained

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *File:* `README.md` (Lines 79–95 trade-offs table, Lines 356–408 Known Limitations); `docs/architecture.md` §11
- **Reasoning:** Each trade-off is named, its invariant benefit is stated, and its cost is honestly acknowledged. The Known Limitations section documents six accepted deficiencies (audit under-count window, single Redis primary ceiling, email aliasing bypass, no rate limiting, no authentication, SSE connection cap) with explicit reasoning for deferral.

---

### [x] Correctness of "one item per user" and "limited stock" under heavy load

- **Verdict:** `PASS`
- **Evidence & Location:**
  - *Files:* `server/src/adapters/redis/order.lua`; `stress/verify.ts`; `stress/k6-order.js`
  - *Code Snippet:* Verifier: `pass: accepted === target` (no oversell, no under-accept); k6 spam threshold: `"spam_wins_202": ["count<=1"]`
- **Reasoning:** Correctness is proven by construction (atomic Lua script) and verified empirically (stress harness + verifier). The Lua script's SISMEMBER→SADD→DECR sequence in a single server-side unit makes overselling and double-ordering structurally impossible — not merely unlikely. The verifier's no-tolerance equality check means any breakage is a hard, detectable failure.

---

## 3. Recommended Remediation Steps

*No remediation steps required. All 47 checklist items passed with direct code evidence.*
