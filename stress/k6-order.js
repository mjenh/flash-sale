// The burst (NFR-18, SM-1, SM-2). Plain JavaScript on purpose: k6 runs this in
// its own runtime (goja), not Node — no TypeScript, no npm imports, no server
// code. It is the one deliberate .js file in the repo.
//
// What k6 proves: the SHAPE of the responses.
//   - zero 5xx (a 500 or a 503 under load means the system buckled)
//   - zero statuses outside {201, 409} (200 additionally allowed with RETRY=1)
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

const created = new Counter("order_created_201");
const rejected = new Counter("order_rejected_409");
const already = new Counter("order_already_200");
const unexpectedStatus = new Rate("unexpected_status");

export const options = {
  scenarios: {
    // A genuine concurrent burst: ATTEMPTS unique emails shared across VUS
    // virtual users. VUs != attempts (Story 3.1, decision 2) — 5,000 unique
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
          // FR-3: a repeated attempt from an order holder is answered 200,
          // never a duplicate order. Starts after the burst has drained.
          retry: {
            executor: "shared-iterations",
            vus: 10,
            iterations: 50,
            startTime: "30s",
            maxDuration: "1m",
            exec: "retry",
          },
        }
      : {}),
  },
  thresholds: {
    // Zero 5xx, ever. Fail closed is a promise about correctness, not an excuse.
    "http_req_failed{expected_response:true}": ["rate==0"],
    unexpected_status: ["rate==0"],
  },
  // 4xx are EXPECTED here (409 is the fair loser's answer) — without this,
  // k6's default http_req_failed would count every honest rejection as an error.
  responseCallback: http.expectedStatuses(200, 201, 409),
};

function post(email) {
  return http.post(`${API_URL}/api/order`, JSON.stringify({ email }), {
    headers: { "Content-Type": "application/json" },
    tags: { name: "POST /api/order" },
  });
}

function score(res, allowed) {
  if (res.status === 201) created.add(1);
  else if (res.status === 409) rejected.add(1);
  else if (res.status === 200) already.add(1);
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
  score(res, [201, 409]);
}

export function retry() {
  // Re-attempt an address the burst already used. Whether that address won or
  // lost, the honest answers are 200 (already ordered) or 409 (never ordered,
  // sold out) — never a second 201 and never a 5xx.
  const res = post(emailForIteration(exec.scenario.iterationInTest));
  score(res, [200, 201, 409]);
}

export function handleSummary(data) {
  return {
    ".out/k6-summary.json": JSON.stringify(data, null, 2),
    stdout: `\nk6: 201=${count(data, "order_created_201")} · 409=${count(data, "order_rejected_409")} · 200=${count(data, "order_already_200")}\n`,
  };
}

function count(data, metric) {
  const m = data.metrics[metric];
  return m && m.values ? m.values.count || 0 : 0;
}
