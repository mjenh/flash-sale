# Stress Test Suite Audit — Flash Sale System
**Principal QA & Performance Engineering Review**
**Date:** 2026-07-15
**Codebase:** `mjenh/flash-sale`
**Files audited:** `stress/k6-order.js`, `stress/run.ts`, `stress/reset.ts`, `stress/verify.ts`, `stress/config.ts`, `stress/test/*.ts`

---

## 1. Stress Test Integrity Grade

| Dimension | Assessment |
|---|---|
| **Overall Grade** | **Partial Pass** |
| **Simulated Concurrency Level** | **True Concurrency** (k6 goroutines, `shared-iterations`, 500 VUs at t=0) |
| **Verification Confidence** | **High for overselling · Medium for per-user deduplication** |

The suite is architecturally sound and far above the median quality bar. The concurrency model is correct, the verification logic is strict, and the reset/isolation protocol is well-engineered. It earns **Partial Pass** rather than **Pass** on two grounds: it does not simulate a true same-user simultaneous spam burst (the retry scenario is sequential), and it has no latency thresholds, meaning event loop starvation is undetectable.

---

## 2. Methodology & Code Analysis

### ✅ STRENGTH — True concurrent burst via `shared-iterations`

**File:** `stress/k6-order.js`, lines 37–48

```js
scenarios: {
  primary: {
    executor: "shared-iterations",
    vus: VUS,          // default 500
    iterations: ATTEMPTS, // default 5,000
    maxDuration: "5m",
    exec: "primary",
  },
```

k6's `shared-iterations` executor spawns all 500 VUs at `t=0` and races them through a single shared pool of 5,000 iterations. Because k6 is written in Go, each VU is a real goroutine — not a JavaScript microtask or a co-operative coroutine. This means 500 concurrent TCP connections arrive at the Node.js event loop nearly simultaneously, creating a genuine thundering-herd pressure on the Lua script's atomic section. The first 500 requests hit the server with millisecond-level separation. This is the correct executor for this scenario.

**Impact:** High. This design is what makes the oversell check meaningful — without it, you could have 500 sequential requests and the test would prove nothing about race conditions.

---

### ✅ STRENGTH — Globally unique email derivation (the `__VU`/`__ITER` trap is avoided)

**File:** `stress/k6-order.js`, lines 91–96 and `stress/test/k6-script.test.ts`, lines 24–27

```js
/** Unique across the WHOLE scenario. A __VU/__ITER pair is NOT: it repeats
 *  across VUs under shared-iterations, which would send duplicate emails, draw
 *  200s, and fail the run for entirely the wrong reason. */
function emailForIteration(i) {
  return `stress-${RUN_TAG}-${i}@example.com`;
}

export function primary() {
  const res = post(emailForIteration(exec.scenario.iterationInTest));
```

`exec.scenario.iterationInTest` is a monotonically increasing integer that is globally unique across all VUs in the scenario. The naive mistake — `${__VU}-${__ITER}` — produces collisions because `__ITER` resets per-VU under `shared-iterations`. This suite avoids that trap, and the unit test pins it explicitly.

**Impact:** High. Using `__VU`/`__ITER` would cause honest 200 ALREADY responses that the threshold would flag as unexpected, making a correct system appear to fail and destroying diagnostic signal.

---

### ✅ STRENGTH — Strict equality verification (no `<=` discipline)

**File:** `stress/verify.ts`, lines 82–108

```ts
const accepted = orderUsers;          // SCARD orders:{saleId}:users
const target = Math.min(apiStockQuantity, expected.attempts);

// ...
{
  name: "accepted orders (SCARD) == min(API stockQuantity, attempts)",
  pass: accepted === target,           // strict ===, not <=
  note: oversell
    ? "OVERSOLD — the one inviolable invariant is broken"
    : underAccept
      ? "UNDER-ACCEPTED — an inflated rejection rate is also a bug"
      : undefined,
},
```

99 accepted orders against a stock of 100 is treated as a bug (UNDER-ACCEPTED) with equal severity to 101 (OVERSOLD). This is the correct discipline: both represent failures of the Lua script's atomic decision — the former means the system rejected a buyer it should have served.

The verifier also cross-checks its own assumption: it reads `apiStockQuantity` from the MongoDB `sales` document rather than trusting the harness-configured `STOCK_QUANTITY`, preventing the harness from silently marking its own homework.

**Impact:** High. A `<=` check would pass an oversell. The cross-check prevents a silent mismatch between what the harness expected and what the API actually booted with.

---

### ✅ STRENGTH — Dual-authority verification (Redis primary, Mongo audit)

**File:** `stress/verify.ts`, lines 82–149

The verifier performs five separate checks, with a deliberate authority hierarchy:

1. `SCARD orders:{saleId}:users == min(stockQuantity, attempts)` — Redis is the fairness authority (the Lua script is the sole writer during serving).
2. `distinct emails == confirmed Mongo orders` — checks for duplicate documents in the audit trail.
3. `Mongo order count` vs. `SCARD` with a tolerance of `max(1, 1%)` — async write-behind lag is accepted; an overcount (Mongo > Redis) is always a hard fail (phantom order).
4. `stock:{saleId}:remaining == apiStockQuantity - accepted` — the Redis stock counter must agree with the SCARD.
5. `harness STOCK_QUANTITY == API seeded stockQuantity` — configuration cross-check.

`pollUntilStable()` avoids a fixed sleep for the async Mongo drain by polling until two consecutive 1-second samples agree on a non-zero plateau. Settling on `0 == 0` before the drain begins is explicitly guarded against via the `minSamples = 3` and `current > 0` conditions.

**Impact:** High. The phantom order check (MongoDB > Redis) is the single most important safety net for write-behind bugs. A system that wrote Mongo records without the Lua script accepting them would be caught here.

---

### ✅ STRENGTH — API-stopped guard before any reset write

**File:** `stress/reset.ts`, lines 77–98; `stress/run.ts`, lines 323–338

```ts
export async function resetAll(ports, stockQuantity, saleId): Promise<ResetResult> {
  const serving = await ports.probeApi();
  if (serving !== null) {
    throw new ApiStillServingError(serving);   // aborts before ANY write
  }

  await ports.deleteOrderUsers();
  for (const name of WIPED_COLLECTIONS) {
    await ports.deleteCollection(name);
  }
  await ports.setStock(stockQuantity);         // sentinel written LAST
```

The guard correctly distinguishes three states: (a) clean ECONNREFUSED → safe to reset; (b) any HTTP response including 503 → still serving, abort; (c) timeout/AbortError → wedged-but-alive, abort. Only (a) permits the reset, preventing a race between the reset's `SET` and the Lua script's `DECR` during a concurrent purchase.

The wipe-first / sentinel-last order is crash-safe: if the process dies mid-reset, `stock:{saleId}:remaining` is absent, which the Lua script treats as an error reply (fail-closed), and the API's cold-start rebuild re-runs the full reconcile on next boot.

**Impact:** High. Resetting Redis while the API serves would inject a synthetic stock value that races the Lua script — a reset that poisons the experiment it is trying to prove.

---

### ✅ STRENGTH — 5xx threshold is untagged (vacuous-threshold trap avoided)

**File:** `stress/k6-order.js`, lines 67–73

```js
thresholds: {
  http_req_failed: ["rate==0"],
  unexpected_status: ["rate==0"],
},
```

`http_req_failed` is intentionally left **untagged**. A 5xx response is tagged `expected_response:false` by k6. An `{expected_response:true}` sub-metric filter would exclude all 5xx from the threshold, making it vacuously pass even when the server is returning 500s. The untagged metric catches everything. The comment in the script documents this reasoning explicitly.

`http.setResponseCallback(http.expectedStatuses(200, 201, 409))` ensures 409s are not counted as failures in `http_req_failed`, while the separate `unexpected_status` Rate metric catches anything outside `{200, 201, 409}`.

**Impact:** High. The vacuous-threshold trap is one of the most common k6 configuration bugs. This suite avoids it correctly.

---

### ✅ STRENGTH — Runner failure vs. threshold breach are distinguished

**File:** `stress/run.ts`, lines 130–219

```ts
const K6_THRESHOLD_EXIT = 99;

function classify(status: number | null, runner: string): K6Result {
  if (status === 0)   return { ok: true, runnerFailed: false, runner };
  if (status === K6_THRESHOLD_EXIT) return { ok: false, runnerFailed: false, ... };
  return { ok: false, runnerFailed: true, ... };  // image not found, script error, etc.
}
```

k6 exits 99 specifically when a threshold is breached. Any other non-zero exit means the runner itself failed (Docker image not found, network error, script parse error). The harness distinguishes these: a runner failure causes the verifier to be skipped with a note ("no burst happened — nothing to verify"), preventing a false UNDER-ACCEPTED verdict against an empty database.

**Impact:** Medium-High. Without this distinction, a misconfigured k6 image produces a misleading failure report that looks like a fairness bug in the system under test.

---

### ⚠️ FLAW — Retry scenario is sequential, not concurrent (per-user spam not tested)

**File:** `stress/k6-order.js`, lines 103–113

```js
export function retry() {
  const email = `retry-${RUN_TAG}-${exec.scenario.iterationInTest}@example.com`;
  // Prime: win a unit (201) or sold out (409).
  score(post(email), [201, 409]);
  // SAME holder re-attempts — sequential, not concurrent.
  score(post(email), [200, 409]);
}
```

The retry scenario (enabled with `RETRY=1`) sends 50 iterations across 10 VUs. Each iteration sends two POSTs for the **same email** — but sequentially: the first awaits before the second fires. This proves the idempotent-retry contract **at human timescales** (request 2 follows request 1 by tens of milliseconds), but does NOT simulate a user hammering "Buy" 50 times simultaneously.

What is not tested: 10 goroutines all firing the identical email at the same millisecond. If the Lua script's `SISMEMBER → SADD` were not atomic (e.g., if they were two separate Redis calls), that race could produce duplicate SADD operations and a phantom order. The suite relies on the Lua script unit tests in `server/test/order-script.test.ts` to prove atomicity, then trusts that proof in the stress test. This is a reasonable layered strategy, but the stress test itself cannot catch a regression that breaks atomicity.

**Impact on accuracy:** Medium. The omission is mitigated by the Lua script being Redis's single-threaded execution context (no interleaving is physically possible). But if the script were ever refactored into two round-trips, the stress test would not catch the resulting race.

---

### ⚠️ FLAW — No latency thresholds; event loop starvation is undetectable

**File:** `stress/k6-order.js`, lines 67–73

```js
thresholds: {
  http_req_failed: ["rate==0"],
  unexpected_status: ["rate==0"],
},
```

There is no P95 or P99 latency threshold. A run where every request eventually returns 201/409 but takes 15 seconds each would pass all thresholds. Node.js event loop starvation, slow Lua script execution under high XREADGROUP pressure, or a MongoDB write-behind queue backup causing backpressure would be invisible to this suite.

**Impact on accuracy:** Medium. The test proves correctness (right answer) but not liveness (timely answer). A system that serializes all 5,000 requests through a bottleneck and takes 10 minutes to serve 100 orders would still pass.

---

### ⚠️ FLAW — Window phase uses a sequential `for` loop (not a concurrent probe)

**File:** `stress/run.ts`, lines 259–287

```ts
for (let i = 0; i < 20; i += 1) {
  const res = await fetch(`${config.apiUrl}/api/order`, {
    ...
    body: JSON.stringify({ email: `window-${Date.now()}-${i}@example.com` }),
  });
  // ...
}
```

The 20 out-of-window rejection checks fire sequentially (each `await` inside the loop waits for the previous response). This is fine for proving the window boundary behaves correctly, because window rejection is a synchronous clock check that requires no Redis or Mongo I/O. However, it means the window phase does not stress-test the "many buyers arrive at exactly the sale's opening second" boundary — the interesting concurrency case where some requests arrive inside and some outside the window.

**Impact on accuracy:** Low. The window check's purpose is correctness (are closed-window requests rejected with the right status and body), not concurrency. The concurrent boundary case is implicitly covered by the k6 burst running inside the window.

---

### ℹ️ NOTE — Audit tolerance accepts up to 1% Mongo undercount

**File:** `stress/verify.ts`, lines 88 and 116–127

```ts
const tolerance = expected.auditTolerance ?? Math.max(1, Math.ceil(target * 0.01));

// ...
note:
  auditUnder <= tolerance
    ? `audit undercount of ${auditUnder} within tolerance — an accepted property`
    : `audit undercount of ${auditUnder} EXCEEDS tolerance`
```

With the default 100-unit stock, the tolerance is 1: if one async Mongo write was lost (Redis accepted 100 but Mongo only confirmed 99), the verifier passes with a note. This is an architectural decision — the write-behind worker drains into Mongo asynchronously, and a transient Mongo hiccup can lose an audit write without breaking the system's fairness invariant (Redis is the authority). The behavior is explicitly documented, and phantom orders (Mongo > Redis) remain a hard fail regardless.

**Impact on accuracy:** Low under normal conditions. A concern only if the worker has a systematic bug that drops audit writes; in that case the tolerance could mask up to 1 lost write.

---

## 3. The Concurrency "Leak" Assessment

### Can it catch overselling?
**Yes — with high confidence.**

The verifier's `SCARD orders:{saleId}:users === min(stockQuantity, attempts)` check with strict equality (not `<=`) will catch any oversell of 1 or more units. The Lua script's `DECR` and `SADD` are Redis single-threaded operations. The k6 burst fires 500 true concurrent goroutines. If any race condition in the application layer (outside the Lua script) allowed two threads to read the same stock count before decrementing, the SCARD would exceed `stockQuantity` and the verifier would fail with "OVERSOLD — the one inviolable invariant is broken."

The additional stock key check (`stock:{saleId}:remaining == stockQuantity - accepted`) provides a second, independent signal for the same class of bug.

### Can it catch duplicate user purchases?
**Partially — at sequential timescales only.**

The retry scenario proves that a user who has already purchased is answered 200 (ALREADY) on a re-attempt when the requests are sequential. The Lua script's `SISMEMBER` check before `SADD` guarantees this atomically. However, the test does not fire N truly simultaneous requests from the same email to verify that exactly one succeeds (201) and the rest are rejected (200/409). If the `SISMEMBER → SADD` were ever de-atomized into separate Redis calls, the stress test would not catch the resulting race; only the Lua unit tests in `order-script.test.ts` would.

The `distinct emails == order count` check in the verifier provides a post-hoc duplicate signal via the Mongo audit trail, but only for duplicates that survive as confirmed order documents.

### Can it catch event loop starvation / timeouts?
**No.**

There are no P95/P99/median latency thresholds in the k6 configuration. A system that is stalling requests in a queue and serving them 10 seconds late (or 30 seconds late, within `maxDuration: "5m"`) would pass all thresholds as long as it eventually returns 201/409 with zero 5xx. Event loop starvation, Redis pipeline backpressure, and XREADGROUP consumer lag are all invisible to this suite.

---

## 4. Recommended Code Fixes for the Test Suite

### Fix 1 — Add latency thresholds to catch starvation and timeouts

This is the highest-priority gap. Add P95 and P99 response-time thresholds:

```js
// stress/k6-order.js — add to the thresholds block

thresholds: {
  http_req_failed: ["rate==0"],
  unexpected_status: ["rate==0"],
  // P95 under 500ms and P99 under 2s are generous for a local stack.
  // Tighten for production SLAs. These catch event loop starvation and
  // backpressure from the write-behind queue.
  "http_req_duration{name:'POST /api/order'}": [
    "p(95)<500",
    "p(99)<2000",
  ],
},
```

The `{name:'POST /api/order'}` tag filter (set via `tags: { name: "POST /api/order" }` already present on line 80) scopes the threshold to the order endpoint only, so k6 housekeeping requests don't skew the percentile.

---

### Fix 2 — Add a simultaneous per-user spam scenario

Replace the sequential retry scenario with a true concurrent fan-out to prove deduplication under simultaneous same-email pressure:

```js
// stress/k6-order.js — add as a new scenario alongside primary

...(RETRY
  ? {
      // Sequential idempotency (existing retry scenario)
      retry: { ... },

      // NEW: true concurrent fan-out from one email. If SISMEMBER→SADD
      // were ever de-atomized, exactly one VU would win and the rest would
      // race to insert — producing phantom 201s and a verifier OVERSOLD.
      spam: {
        executor: "shared-iterations",
        vus: 20,
        iterations: 20,    // all 20 VUs share ONE email address
        maxDuration: "30s",
        exec: "spam",
      },
    }
  : {}),
```

```js
// The shared email — all 20 VUs fire this address simultaneously.
const SPAM_EMAIL = `spam-${RUN_TAG}@example.com`;

export function spam() {
  // All VUs race this single email. Exactly one must win (201 or 409 if sold out);
  // every other response must be 200 (ALREADY) or 409 (sold out).
  // A second 201 for the same address is a hard oversell via the verifier.
  score(post(SPAM_EMAIL), [201, 200, 409]);
}
```

This creates a genuine SISMEMBER race: 20 goroutines call the order endpoint with the same email at nearly the same instant. Because the Lua script is Redis single-threaded, only one SADD can succeed, so at most one 201 is possible. Any regression that breaks this atomicity (e.g., splitting into two Redis calls) will produce multiple 201s, which the verifier will catch as an OVERSOLD because the user set gains a duplicate.

---

### Fix 3 — Assert the spam scenario produces exactly one winner

Add a dedicated k6 counter and threshold for the spam scenario:

```js
const spamWins = new Counter("spam_wins_201");

export function spam() {
  const res = post(SPAM_EMAIL);
  if (res.status === 201) spamWins.add(1);
  score(res, [201, 200, 409]);
}
```

```js
thresholds: {
  // ...existing thresholds...
  // The spam fan-out must produce AT MOST one winner (201).
  // Use `count<=1` — if the sale was already sold out before the spam scenario
  // ran, 0 wins is also correct (all get 409). The verifier's SCARD check
  // catches oversells independently.
  "spam_wins_201": ["count<=1"],
},
```

---

### Fix 4 — Make the window phase concurrent (optional, low priority)

Replace the sequential loop with a `Promise.all` fan-out for a more honest closed-window test:

```ts
// stress/run.ts — windowPhase(), replace the for loop

const requests = Array.from({ length: 20 }, (_, i) =>
  fetch(`${config.apiUrl}/api/order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `window-${Date.now()}-${i}@example.com` }),
  }).then(async (res) => {
    let body: { success?: unknown; error?: unknown } = {};
    try { body = await res.json(); } catch {}
    return { i, status: res.status, body };
  }),
);

const results = await Promise.all(requests);
const failures = results.filter(
  ({ status, body }) =>
    status !== 409 || body.success !== false || body.error !== "Sale is not active.",
);
```

This is low priority — the window check is a correctness probe, not a concurrency probe. But the concurrent version provides stronger evidence that the window boundary holds under simultaneous arrival.

---

## Summary Scorecard

| Criterion | Current | Grade |
|---|---|---|
| True concurrency | `shared-iterations`, 500 VUs, goroutines | ✅ Pass |
| Email uniqueness | `exec.scenario.iterationInTest` | ✅ Pass |
| Oversell detection | Strict `===`, dual-store, phantom check | ✅ Pass |
| Deduplication under load | Sequential retry only; no simultaneous spam fan-out | ⚠️ Partial |
| Event loop starvation | No latency thresholds | ❌ Fail |
| Environment isolation | Stop → wipe → sentinel → start | ✅ Pass |
| State reset idempotency | Crash-safe order, guard prevents race | ✅ Pass |
| 5xx / error rate | Untagged threshold, vacuous-threshold trap avoided | ✅ Pass |
| Harness self-verification | Runner failure vs. threshold breach distinguished | ✅ Pass |
| Window enforcement | 20 sequential probes — correct but not concurrent | ⚠️ Partial |
