// The burst. Plain JavaScript on purpose: k6 runs this in
// its own runtime (goja), not Node — no TypeScript, no npm imports, no server
// code. It is the one deliberate .js file in the repo.
//
// What k6 proves: the SHAPE of the responses.
//   - zero 5xx (a 500 or a 503 under load means the system buckled)
//   - zero statuses outside {202, 409} (200 additionally allowed with RETRY=1)
// What k6 does NOT prove: the exact counts. That is verify.ts's job, against
// the databases — k6's counters below are corroboration, never proof.
import http from "k6/http";
import exec from "k6/execution";
import { Counter, Rate } from "k6/metrics";

const API_URL = (__ENV.API_URL || "http://localhost:3000").replace(/\/$/, "");
const ATTEMPTS = Number(__ENV.ATTEMPTS || 5000);
const VUS = Number(__ENV.VUS || 500);
const RETRY = __ENV.RETRY === "1" || __ENV.RETRY === "true";
// Emails must be unique per RUN, not per process: a second harness run against
// a database that was reset still reuses the same addresses, which is fine —
// but two runs against a NON-reset database would collide. run.ts always resets.
const RUN_TAG = __ENV.RUN_TAG || "s";

const created = new Counter("order_created_202");
const rejected = new Counter("order_rejected_409");
const already = new Counter("order_already_200");
const unexpectedStatus = new Rate("unexpected_status");
const fivexx = new Counter("order_5xx");
// Counts 202s from the spam scenario. Must stay ≤ 1: all 20 VUs share one
// email address, so at most one can win a unit. The threshold spam_wins_202
// enforces this; the verifier's SCARD check is the independent safety net.
const spamWins = new Counter("spam_wins_202");

// The single email shared by all spam VUs. One address, 20 simultaneous
// goroutines — a genuine SISMEMBER race if the Lua script were ever de-atomized.
const SPAM_EMAIL = `spam-${RUN_TAG}@example.com`;

// 4xx are EXPECTED here (409 is the fair loser's answer) — without this,
// k6's default http_req_failed would count every honest rejection as an error.
// 202 (not 201) is the server's "order accepted" status: the route enqueues
// to the Redis stream and immediately returns 202 Accepted; the worker drains
// to Mongo asynchronously. Excluding 202 from expectedStatuses would mark
// every winning request as http_req_failed and breach that threshold.
// NOTE: `setResponseCallback` is the correct init-context API; the old
// `options.responseCallback` field is not recognized by k6 ≥ 2.x and caused
// a "unknown field" warning that left the default callback in place, making
// every 409 count as a failure and breaching the http_req_failed threshold.
http.setResponseCallback(http.expectedStatuses(200, 202, 409));

export const options = {
  scenarios: {
    // A genuine concurrent burst: ATTEMPTS unique emails shared across VUS
    // virtual users. VUs != attempts — 5,000 unique
    // BUYERS is the claim; 5,000 simultaneous OS threads is not.
    primary: {
      executor: "shared-iterations",
      vus: VUS,
      iterations: ATTEMPTS,
      maxDuration: "5m",
      exec: "primary",
    },
    ...(RETRY
      ? {
          // A repeated attempt from an order holder is answered 200, never a
          // duplicate order. Runs in its OWN email namespace (see retry()), so
          // it can never perturb primary's strict {202, 409} outcome — the old
          // shared range + fixed startTime raced primary and could draw the 202
          // first, forcing primary into a 200 and failing a correct system.
          retry: {
            executor: "shared-iterations",
            vus: 10,
            iterations: 50,
            maxDuration: "1m",
            exec: "retry",
          },
        }
      : {}),
    // True concurrent fan-out from a SINGLE email address. All 20 VUs share
    // SPAM_EMAIL and race the order endpoint simultaneously. Always runs as a
    // deduplication correctness probe — NOT gated on RETRY — because the
    // SISMEMBER→SADD atomicity invariant must be verified on every stress run,
    // not only when idempotent-retry UX coverage is also desired. If the Lua
    // script were ever de-atomized into two round-trips, a second SADD could
    // slip through and the SCARD would register an oversell — caught immediately
    // by both the spam_wins_202 threshold and the verifier.
    spam: {
      executor: "shared-iterations",
      vus: 20,
      iterations: 20,
      maxDuration: "30s",
      exec: "spam",
    },
  },
  thresholds: {
    // Zero 5xx, ever. Fail closed is a promise about correctness, not an excuse.
    // Untagged on purpose: a 5xx is tagged expected_response:false and would be
    // EXCLUDED from an {expected_response:true} sub-metric, making that
    // threshold vacuous.
    http_req_failed: ["rate==0"],
    unexpected_status: ["rate==0"],
    // Liveness thresholds scoped to the order endpoint. P95 < 500ms and
    // P99 < 2s are generous for a local stack — tighten for production SLAs.
    // These catch event loop starvation and write-behind queue backpressure
    // that correctness checks cannot detect (a stalled system that eventually
    // returns the right status code would otherwise pass silently).
    "http_req_duration{name:'POST /api/order'}": ["p(95)<500", "p(99)<2000"],
    // The spam fan-out must produce AT MOST one 202 for the shared email.
    // 0 wins is also valid — the sale may have sold out before spam ran.
    // The verifier's SCARD check independently catches any oversell.
    spam_wins_202: ["count<=1"],
  },
};

function post(email) {
  return http.post(`${API_URL}/api/order`, JSON.stringify({ email }), {
    headers: { "Content-Type": "application/json" },
    tags: { name: "POST /api/order" },
  });
}

function score(res, allowed) {
  if (res.status === 202) created.add(1);
  else if (res.status === 409) rejected.add(1);
  else if (res.status === 200) already.add(1);
  else if (res.status >= 500) fivexx.add(1);
  unexpectedStatus.add(allowed.indexOf(res.status) === -1);
}

/** Unique across the WHOLE scenario. A __VU/__ITER pair is NOT: it repeats
 *  across VUs under shared-iterations, which would send duplicate emails, draw
 *  200s, and fail the run for entirely the wrong reason. */
function emailForIteration(i) {
  return `stress-${RUN_TAG}-${i}@example.com`;
}

export function primary() {
  const res = post(emailForIteration(exec.scenario.iterationInTest));
  score(res, [202, 409]);
}

export function retry() {
  // A DEDICATED address space (never primary's range), so this scenario can
  // never race primary into an unexpected 200 and fail a correct run
  // Each iteration proves the idempotent-retry contract end to end against its own holder.
  const email = `retry-${RUN_TAG}-${exec.scenario.iterationInTest}@example.com`;
  // Prime: the holder either wins a unit (202) or the sale is sold out (409).
  score(post(email), [202, 409]);
  // The SAME holder re-attempts. Never a second 202, never a 5xx — 200 if they
  // already hold an order, 409 if the sale sold out before they got a unit.
  score(post(email), [200, 409]);
}

export function spam() {
  // All 20 VUs fire SPAM_EMAIL at the same instant — a genuine SISMEMBER race.
  // Exactly one VU may receive 202; the rest must get 200 (ALREADY) or 409
  // (sold out). A second 202 for the same address is physically impossible
  // under the Lua script's atomic SISMEMBER→SADD, but if atomicity were ever
  // broken this fan-out would catch it: spamWins would exceed 1, breaching the
  // spam_wins_202 threshold, and the verifier's SCARD would register OVERSOLD.
  const res = post(SPAM_EMAIL);
  if (res.status === 202) spamWins.add(1);
  score(res, [202, 200, 409]);
}

export function handleSummary(data) {
  return {
    ".out/k6-summary.json": JSON.stringify(data, null, 2),
    stdout: `\nk6: 202=${count(data, "order_created_202")} · 409=${count(data, "order_rejected_409")} · 200=${count(data, "order_already_200")} · 5xx=${count(data, "order_5xx")}\n`,
  };
}

function count(data, metric) {
  const m = data.metrics[metric];
  return m && m.values ? m.values.count || 0 : 0;
}
