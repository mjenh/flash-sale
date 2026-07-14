// The protocol, in the only order that is honest:
//   stop API → reset → start API → k6 → verifier → (window phase)
//
// - Reset while the API serves would race the Lua script's sole-writer rule.
// - The API restarts AFTER the wipe so the boot rebuild re-establishes a
//   clean, boot-verified state.
// - The verifier runs LAST and polls, because the Mongo audit write is async
//   by design.
//
// Every phase prints as it starts and hard-fails the run on error. The combined
// exit code is the pass/fail signal: 0 only when every phase passed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { loadStressConfig, type StressConfig } from "./config.ts";
import { runReset, stockKeyFor } from "./reset.ts";
import { runVerify } from "./verify.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..");
const STRESS_ENV_FILE = resolvePath(REPO_ROOT, ".env.stress");

/** Load .env.stress into process.env so the harness config and Docker Compose
 *  always agree on STOCK_QUANTITY, the sale window, and store URLs. Values
 *  already present in process.env take precedence (explicit overrides win). */
function loadStressEnv(): void {
  if (!existsSync(STRESS_ENV_FILE)) {
    return; // fall back to process.env / defaults — backwards compatible
  }
  const lines = readFileSync(STRESS_ENV_FILE, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    // Do not overwrite explicit env — `STOCK_QUANTITY=200 npm run stress` wins.
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadStressEnv();

interface Phase {
  name: string;
  ok: boolean;
  detail?: string;
}

const phases: Phase[] = [];

/** k6's corroborating counters, folded in from .out/k6-summary.json for the
 *  finish() report. Undefined until the burst has run. */
let k6Summary: string | undefined;

/** A Node fetch() connection refusal surfaces as a TypeError whose `cause`
 *  carries `code: "ECONNREFUSED"`. A TimeoutError/AbortError (a wedged but
 *  still-bound API) is NOT a refusal — only a genuine refusal proves nothing is
 *  listening. */
function isConnectionRefused(err: unknown): boolean {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ECONNREFUSED";
}

function announce(name: string): void {
  console.log(`\n=== ${name} ===`);
}

function record(name: string, ok: boolean, detail?: string): boolean {
  phases.push({ name, ok, detail });
  return ok;
}

function compose(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  // --env-file .env.stress ensures Docker Compose variable interpolation uses
  // the stress config (especially STOCK_QUANTITY), not the developer's .env.
  const envFileArgs = existsSync(STRESS_ENV_FILE) ? ["--env-file", STRESS_ENV_FILE] : [];
  const res = spawnSync("docker", ["compose", ...envFileArgs, ...args], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env,
  });
  return res.status ?? 1;
}

async function waitForApi(config: StressConfig, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${config.apiUrl}/api/sale/status`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.status === 200) {
        return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function waitForApiStopped(config: StressConfig, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${config.apiUrl}/api/sale/status`, { signal: AbortSignal.timeout(1000) });
    } catch (err) {
      // ONLY a genuine connection refusal proves nothing is listening. A
      // timeout/abort means the API is wedged-but-alive — keep waiting, never
      // declare it stopped and let the reset race the Lua script.
      if (isConnectionRefused(err)) {
        return true;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** k6's exit code for "a threshold was breached" — every other non-zero code
 *  means the RUNNER failed (image not found, daemon down, script error), which
 *  is a completely different fact and must never be reported as a threshold
 *  breach. That conflation is exactly what turned a missing image into
 *  "a threshold failed (5xx …)" on the first live run. */
const K6_THRESHOLD_EXIT = 99;

/** Overridable: `K6_IMAGE=grafana/k6:latest npm run stress`. The spine pins k6
 *  2.1 — the image TAG for that release is `2.1.0`, not `2.1` (a `2.1` tag has
 *  never existed, which is why the first live run could not pull it). */
const K6_IMAGE = process.env.K6_IMAGE ?? "grafana/k6:2.1.0";

interface K6Result {
  /** The burst ran and every threshold held. */
  ok: boolean;
  /** The burst never ran at all — the runner itself failed. */
  runnerFailed: boolean;
  runner: string;
  detail?: string;
}

/** k6 runs from a host binary when one exists; otherwise from its official
 *  image — "Docker available" is this story's only stated prerequisite, so
 *  requiring a host k6 install would break the one-command promise. */
function runK6(config: StressConfig): K6Result {
  const env = {
    API_URL: config.apiUrl,
    ATTEMPTS: String(config.attempts),
    VUS: String(config.vus),
    RETRY: config.retry ? "1" : "0",
    RUN_TAG: String(Date.now()),
  };

  // handleSummary() writes here; k6 will not create the directory itself.
  mkdirSync(resolvePath(HERE, ".out"), { recursive: true });

  const hasK6 = spawnSync("k6", ["version"], { stdio: "ignore" }).status === 0;
  if (hasK6) {
    const res = spawnSync("k6", ["run", "k6-order.js"], {
      cwd: HERE,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    return classify(res.status, "k6 (host binary)");
  }

  // Container path. --network host lets the container reach the API on
  // localhost; on Docker Desktop (where --network host is a no-op for the
  // host's loopback) API_URL is rewritten to host.docker.internal.
  const containerApiUrl = config.apiUrl.replace("localhost", "host.docker.internal");
  const dockerArgs = [
    "run",
    "--rm",
    "-i",
    // grafana/k6 runs as a non-root user; run it as the host UID so it can
    // write .out/ on the host-owned bind mount.
    ...(process.getuid ? ["--user", String(process.getuid())] : []),
    "--network",
    "host",
    "--add-host=host.docker.internal:host-gateway",
    "-v",
    `${HERE}:/stress`,
    "-w",
    "/stress",
    ...Object.entries({ ...env, API_URL: containerApiUrl }).flatMap(([k, v]) => [
      "-e",
      `${k}=${v}`,
    ]),
    K6_IMAGE,
    "run",
    "k6-order.js",
  ];
  const res = spawnSync("docker", dockerArgs, { stdio: "inherit" });
  return classify(res.status, `k6 (${K6_IMAGE} container)`);
}

function classify(status: number | null, runner: string): K6Result {
  if (status === 0) {
    return { ok: true, runnerFailed: false, runner };
  }
  if (status === K6_THRESHOLD_EXIT) {
    return {
      ok: false,
      runnerFailed: false,
      runner,
      detail: "a k6 threshold was breached (a 5xx, or a status outside {201, 409})",
    };
  }
  return {
    ok: false,
    runnerFailed: true,
    runner,
    detail: `the burst never ran — ${runner} exited ${status ?? "on a signal"} (image not found? docker daemon down? script error?). No conclusion about fairness can be drawn from this run.`,
  };
}

/** The burst writes .out/k6-summary.json (handleSummary) — fold its
 *  corroborating counters (201/409/200 and any 5xx) into the harness report so
 *  the finish() output prints the shape the README promises. */
function readK6Summary(): string | undefined {
  try {
    const raw = readFileSync(resolvePath(HERE, ".out", "k6-summary.json"), "utf8");
    const data = JSON.parse(raw) as { metrics?: Record<string, { values?: { count?: number } }> };
    const count = (metric: string): number => data.metrics?.[metric]?.values?.count ?? 0;
    return `k6 counters — 201=${count("order_created_201")} · 409=${count("order_rejected_409")} · 200=${count("order_already_200")} · 5xx=${count("order_5xx")}`;
  } catch {
    return undefined;
  }
}

/** Attempts outside the window are ALL rejected with
 *  { success: false }. The window is boot-parsed config, so the only
 *  honest way to prove this against the deployed stack is to restart the API
 *  with a past window and knock on the door. */
async function windowPhase(config: StressConfig): Promise<boolean> {
  const closed = {
    ...process.env,
    SALE_START_TIME: "2020-01-01T00:00:00Z",
    SALE_END_TIME: "2020-01-02T00:00:00Z",
  };

  // The restore is wrapped in a finally so it ALWAYS runs — even on an early
  // return or a throw. An interrupted window phase must never leave the API
  // pinned to the 2020 closed window while the run can still print PASS
  // The restore is its own recorded pass/fail phase.
  try {
    if (compose(["up", "-d", "--wait", "api"], closed) !== 0) {
      return record("window phase", false, "could not restart the api with a closed window");
    }
    if (!(await waitForApi(config))) {
      return record("window phase", false, "api never became ready with the closed window");
    }

    const failures: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const res = await fetch(`${config.apiUrl}/api/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `window-${Date.now()}-${i}@example.com` }),
      });
      let body: { success?: unknown; error?: unknown } = {};
      try {
        body = (await res.json()) as { success?: unknown; error?: unknown };
      } catch {
        // A non-JSON body is itself a breach of the closed-window contract —
        // fall through and let the assertion below record the failure.
      }
      if (res.status !== 409 || body.success !== false || body.error !== "Sale is not active.") {
        failures.push(`attempt ${i}: HTTP ${res.status} ${JSON.stringify(body)}`);
      }
    }

    if (failures.length > 0) {
      console.error(failures.join("\n"));
      return record(
        "window phase",
        false,
        `${failures.length}/20 out-of-window attempts were not rejected with 409 { success: false, error: "Sale is not active." }`,
      );
    }
    console.log('20/20 out-of-window attempts rejected: 409 { success: false, error: "Sale is not active." }');
    return record("window phase", true);
  } finally {
    await restoreOpenWindow(config);
  }
}

/** Restore the compose-default (active) window so the stack is left usable, and
 *  PROVE it landed there before the harness can declare success. */
async function restoreOpenWindow(config: StressConfig): Promise<boolean> {
  if (compose(["up", "-d", "--wait", "api"]) !== 0) {
    return record("window restore", false, "docker compose could not restart the api on the default (open) window");
  }
  if (!(await waitForApi(config))) {
    return record("window restore", false, "the api never became ready after restoring the default window");
  }
  // Within [start, end) the status is "active" or "sold_out"; "upcoming" or
  // "ended" would mean the 2020 closed window is still in force.
  try {
    const res = await fetch(`${config.apiUrl}/api/sale/status`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { status?: unknown };
    if (body.status !== "active" && body.status !== "sold_out") {
      return record("window restore", false, `the api is not back on the open window (status=${JSON.stringify(body.status)})`);
    }
  } catch (err) {
    return record("window restore", false, `could not confirm the restored window: ${err instanceof Error ? err.message : String(err)}`);
  }
  return record("window restore", true);
}

async function main(): Promise<void> {
  const config = loadStressConfig();
  console.log(
    `stress harness — ${config.attempts} unique emails · ${config.vus} VUs · STOCK_QUANTITY=${config.stockQuantity} · api ${config.apiUrl}`,
  );

  announce("1/6 stop API (and bring the stores up)");
  if (compose(["stop", "api"]) !== 0) {
    record("stop API", false, "docker compose stop api failed");
    return finish();
  }
  // The reset speaks to Redis and Mongo directly, from the host — so the
  // stores must be up BEFORE it runs. On a fresh clone (or after `make clean`)
  // nothing is running at all, and the reset would otherwise hang against a
  // socket that will never answer.
  if (compose(["up", "-d", "--wait", "redis", "mongo"]) !== 0) {
    record("stop API", false, "redis/mongo could not be started (docker compose up -d --wait redis mongo)");
    return finish();
  }
  if (!(await waitForApiStopped(config))) {
    record("stop API", false, `${config.apiUrl} is still answering after 'docker compose stop api'`);
    return finish();
  }
  record("stop API", true);

  announce("2/6 reset (API stopped)");
  try {
    const result = await runReset(config);
    console.log(
      `${stockKeyFor(result.saleId)} = ${result.stockQuantity}; cleared ${result.cleared.join(", ")}`,
    );
    record("reset", true);
  } catch (err) {
    record("reset", false, err instanceof Error ? err.message : String(err));
    return finish();
  }

  announce("3/6 start API");
  if (compose(["up", "-d", "--wait", "api"]) !== 0 || !(await waitForApi(config))) {
    record("start API", false, "the api never became ready");
    return finish();
  }
  record("start API", true);

  announce("4/6 k6 burst");
  const k6 = runK6(config);
  console.log(`runner: ${k6.runner}`);
  k6Summary = readK6Summary();
  if (k6Summary !== undefined) {
    console.log(k6Summary);
  }
  record(k6.runnerFailed ? "k6 burst (RUNNER FAILED — no burst happened)" : "k6 thresholds", k6.ok, k6.detail);

  // A burst that never ran tells us nothing about fairness. Running the
  // verifier anyway would print a confident UNDER-ACCEPTED against an empty
  // database — a real-looking failure caused entirely by the harness.
  if (k6.runnerFailed) {
    record("verifier", false, "skipped — the burst never ran, so there is nothing to verify");
    return finish();
  }

  announce("5/6 verifier");
  try {
    record("verifier", await runVerify(config));
  } catch (err) {
    record("verifier", false, err instanceof Error ? err.message : String(err));
  }

  announce("6/6 window phase");
  await windowPhase(config);

  finish();
}

function finish(): void {
  const failed = phases.filter((p) => !p.ok);
  console.log("\n──────── stress harness ────────");
  for (const p of phases) {
    console.log(`${p.ok ? "PASS" : "FAIL"}  ${p.name}${p.detail === undefined ? "" : `\n      ${p.detail}`}`);
  }
  if (k6Summary !== undefined) {
    console.log(k6Summary);
  }
  console.log(failed.length === 0 ? "\nPASS — the fairness claim holds.\n" : `\nFAIL — ${failed.length} phase(s) failed.\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

// A bare `await main()` would let a StressConfigError, an unhandled rejection,
// or any throw before finish() escape as a raw stack trace instead of the
// pass/fail summary. Record the abort as a failed phase and route
// through finish() so the summary and the non-zero exit code are still honored.
main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\nstress harness aborted before it could finish: ${message}`);
  record("harness", false, message);
  finish();
});
