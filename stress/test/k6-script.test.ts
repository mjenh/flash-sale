// A SYNTAX GATE, and nothing more. Be clear about what this does not prove:
// k6 scripts run in k6's own runtime (goja) with `k6/*` imports that do not
// exist under Node, so the script cannot be imported or executed here. Loading
// it under Vitest would require stubbing k6 itself — a test of the stub, not of
// the burst. The burst is proven only by running it (see the Dev Agent Record).
//
// What IS checked: the file parses, and the traps that would silently produce a
// WRONG result are absent — duplicate emails from `${__VU}-${__ITER}` (which
// would draw 200s and fail the run for the wrong reason), a one-sided threshold
// that lets a 5xx through, and the spam scenario being gated on RETRY (which
// would silently skip the deduplication race on every default stress run).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../k6-order.js", import.meta.url));
const source = readFileSync(SCRIPT, "utf8");

describe("k6-order.js", () => {
  it("parses as valid JavaScript", () => {
    expect(() => execFileSync(process.execPath, ["--check", SCRIPT])).not.toThrow();
  });

  it("derives each email from the scenario-wide iteration, never `__VU`/`__ITER`", () => {
    expect(source).toContain("exec.scenario.iterationInTest");
    expect(source).not.toMatch(/\$\{__VU\}-\$\{__ITER\}/);
  });

  it("fires ATTEMPTS iterations across VUS virtual users (a shared-iterations burst)", () => {
    expect(source).toContain('executor: "shared-iterations"');
    expect(source).toContain("iterations: ATTEMPTS");
  });

  it("fails the run on any 5xx and on any status outside the allowed set", () => {
    // Untagged http_req_failed — a 5xx is tagged expected_response:false and
    // would be excluded from an {expected_response:true} sub-metric, making that
    // threshold vacuous.
    expect(source).toContain('http_req_failed: ["rate==0"]');
    expect(source).toContain('unexpected_status: ["rate==0"]');
    // 409 is an honest answer, not an error — without this, every fair rejection
    // would count as a failed request and the thresholds would be meaningless.
    // 202 (not 201) is the server's accepted status: the route enqueues to the
    // Redis stream and returns 202 Accepted immediately; Mongo is written
    // asynchronously by the worker.
    expect(source).toContain("http.expectedStatuses(200, 202, 409)");
  });

  it("posts to the order endpoint with the `email` field (never `userId`)", () => {
    expect(source).toContain("/api/sales/");
    expect(source).toContain("/order");
    expect(source).toContain("JSON.stringify({ email })");
    expect(source).not.toContain("userId");
  });

  it("spam scenario runs unconditionally — not gated on RETRY", () => {
    // The spam scenario is a deduplication correctness probe (SISMEMBER race)
    // that must run on every stress invocation. The retry scenario is opt-in
    // UX coverage and may remain gated. Structural check: `spam:` must not
    // appear inside the RETRY ternary block.
    const retryBlock = source.match(/\.\.\.\(RETRY\s*\?([\s\S]*?):\s*\{\}\)/);
    expect(retryBlock).not.toBeNull(); // RETRY ternary still exists for retry scenario
    expect(retryBlock?.[1]).not.toContain("spam:");
    // The spam executor must always be present in the source.
    expect(source).toContain('exec: "spam"');
    // The spam_wins_202 threshold (202 = write-behind accept status) must be
    // unconditional — always enforced, never vacuous.
    expect(source).toContain('spam_wins_202: ["count<=1"]');
  });
});
