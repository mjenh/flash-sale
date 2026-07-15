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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import mongoose from "mongoose";
import { loadStressConfig, SALE_SLUG, type StressConfig } from "./config.ts";
import { runReset, stockKeyFor, isConnectionRefused } from "./reset.ts";
import { runVerify, type VerifyReport } from "./verify.ts";
import { generateReport } from "./report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..");
const STRESS_ENV_FILE = resolvePath(REPO_ROOT, ".env.stress");

/** Load .env.stress into process.env so the harness config and Docker Compose
 *  always agree on STOCK_QUANTITY, the sale window, and store URLs. Values
 *  already present in process.env take precedence (explicit overrides win). */
function loadStressEnv(): void {
  if (!existsSync(STRESS_ENV_FILE)) {
    // No stress env file — fall back to process.env defaults. Backwards compatible.
    return;
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

/** yyyymmdd_hhmm — determined once at process start so every file in this run
 *  lands in the same folder regardless of how long the harness takes. */
function makeRunId(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

const RUN_ID = makeRunId();
/** Absolute path to docs/testing/stress/<yyyymmdd_hhmm>/ — created before k6
 *  runs so handleSummary can write k6-summary.json there. Reports land in
 *  the docs tree so they can be committed and linked from README.md. */
const OUT_DIR = resolvePath(REPO_ROOT, "docs", "testing", "stress", RUN_ID);

interface Phase {
  name: string;
  ok: boolean;
  detail?: string;
}

const phases: Phase[] = [];

/** k6's corroborating counters, folded in from the run's k6-summary.json for
 *  the finish() report. Undefined until the burst has run. */
let k6Summary: string | undefined;

/** Full parsed k6-summary.json for the HTML report. */
let k6SummaryRaw: Record<string, unknown> | undefined;

/** Structured verifier output for the HTML report. */
let verifyReport: VerifyReport | undefined;

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
      const res = await fetch(`${config.apiUrl}/api/sales/${SALE_SLUG}/status`, {
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
      await fetch(`${config.apiUrl}/api/sales/${SALE_SLUG}/status`, { signal: AbortSignal.timeout(1000) });
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
    SALE_SLUG,
    // Relative path from the stress/ working directory — k6 (host binary) and
    // the Docker container (workdir=/repo/stress) both resolve this the same way.
    K6_OUT_DIR: `../docs/testing/stress/${RUN_ID}`,
  };

  // handleSummary() writes into OUT_DIR; k6 will not create the directory itself.
  mkdirSync(OUT_DIR, { recursive: true });

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
    // write .out/<RUN_ID>/ on the host-owned bind mount.
    ...(process.getuid ? ["--user", String(process.getuid())] : []),
    "--network",
    "host",
    "--add-host=host.docker.internal:host-gateway",
    // Mount the repo root so the container can write to docs/testing/stress/
    // via the relative K6_OUT_DIR (../docs/testing/stress/<RUN_ID>).
    // Workdir is /repo/stress so k6-order.js is found at the cwd, same as
    // the host-binary path. The UID binding ensures k6 can write the host-
    // owned output directory.
    "-v",
    `${REPO_ROOT}:/repo`,
    "-w",
    "/repo/stress",
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
      detail: "a k6 threshold was breached (a 5xx, a latency breach, or a status outside {202, 409})",
    };
  }
  return {
    ok: false,
    runnerFailed: true,
    runner,
    detail: `the burst never ran — ${runner} exited ${status ?? "on a signal"} (image not found? docker daemon down? script error?). No conclusion about fairness can be drawn from this run.`,
  };
}

/** The burst writes <OUT_DIR>/k6-summary.json (handleSummary) — fold its
 *  corroborating counters (202/409/200 and any 5xx) into the harness report so
 *  the finish() output prints the shape the README promises. */
function readK6Summary(): string | undefined {
  try {
    const raw = readFileSync(resolvePath(OUT_DIR, "k6-summary.json"), "utf8");
    const data = JSON.parse(raw) as { metrics?: Record<string, { values?: { count?: number } }> };
    const count = (metric: string): number => data.metrics?.[metric]?.values?.count ?? 0;
    return `k6 counters — 202=${count("order_created_202")} · 409=${count("order_rejected_409")} · 200=${count("order_already_200")} · 5xx=${count("order_5xx")}`;
  } catch {
    return undefined;
  }
}

/** Full parsed k6-summary.json for the HTML report — returns undefined on any
 *  parse error so the report generator can degrade gracefully. */
function readK6SummaryRaw(): Record<string, unknown> | undefined {
  try {
    const raw = readFileSync(resolvePath(OUT_DIR, "k6-summary.json"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

interface WindowSnapshot {
  startTime: Date;
  endTime: Date;
}

/** Read the current sale window from MongoDB — snapshot before closing,
 *  restore after the window phase. */
async function captureSaleWindow(mongodbUri: string): Promise<WindowSnapshot> {
  await mongoose.connect(mongodbUri, { serverSelectionTimeoutMS: 5000 });
  try {
    const db = mongoose.connection.db;
    if (db === undefined) throw new Error("Mongo connection has no database handle");
    const sale = await db.collection("sales").findOne({ slug: SALE_SLUG });
    if (sale === null) {
      throw new Error(
        `no sale document with slug "${SALE_SLUG}" in ${mongodbUri} — cannot snapshot the window`,
      );
    }
    return { startTime: sale.startTime as Date, endTime: sale.endTime as Date };
  } finally {
    await mongoose.disconnect();
  }
}

/** Write startTime + endTime to the sale document so the API reads the
 *  new window on its next boot. */
async function setSaleWindow(mongodbUri: string, startTime: Date, endTime: Date): Promise<void> {
  await mongoose.connect(mongodbUri, { serverSelectionTimeoutMS: 5000 });
  try {
    const db = mongoose.connection.db;
    if (db === undefined) throw new Error("Mongo connection has no database handle");
    await db.collection("sales").updateOne({ slug: SALE_SLUG }, { $set: { startTime, endTime } });
  } finally {
    await mongoose.disconnect();
  }
}

/** Attempts outside the window are ALL rejected with { success: false }.
 *  The window is determined by the sale document in MongoDB — not env vars.
 *  Close it by writing a past window to the DB and restarting the API so it
 *  boots with an ended sale; restore the original window in finally. */
async function windowPhase(config: StressConfig): Promise<boolean> {
  let snapshot: WindowSnapshot | null = null;

  try {
    snapshot = await captureSaleWindow(config.mongodbUri);
    await setSaleWindow(
      config.mongodbUri,
      new Date("2020-01-01T00:00:00Z"),
      new Date("2020-01-02T00:00:00Z"),
    );
  } catch (err) {
    return record(
      "window phase",
      false,
      `could not close the sale window in MongoDB: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // The restore is wrapped in a finally so it ALWAYS runs — even on an early
  // return or a throw. An interrupted window phase must never leave the API
  // pinned to the closed window while the run can still print PASS.
  // The restore is its own recorded pass/fail phase.
  try {
    if (compose(["up", "-d", "--force-recreate", "--wait", "api"]) !== 0) {
      return record("window phase", false, "could not restart the api with a closed window");
    }
    if (!(await waitForApi(config))) {
      return record("window phase", false, "api never became ready with the closed window");
    }

    // Concurrent fan-out: all 20 requests fire simultaneously so the window
    // boundary is probed under arrival pressure, not just sequentially. The
    // window check is a correctness probe (is the right status returned?), but
    // simultaneous arrival provides stronger evidence that the boundary holds
    // when requests straddle the same instant.
    const now = Date.now();
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const res = await fetch(`${config.apiUrl}/api/sales/${SALE_SLUG}/order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: `window-${now}-${i}@example.com` }),
        });
        let body: { success?: unknown; error?: unknown } = {};
        try {
          body = (await res.json()) as { success?: unknown; error?: unknown };
        } catch {
          // A non-JSON body is itself a breach of the closed-window contract —
          // fall through and let the assertion below record the failure.
        }
        return { i, status: res.status, body };
      }),
    );

    const failures = results
      .filter(({ status, body }) => status !== 409 || body.success !== false || body.error !== "Sale is not active.")
      .map(({ i, status, body }) => `attempt ${i}: HTTP ${status} ${JSON.stringify(body)}`);

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
    // Restore the original sale window in MongoDB BEFORE restarting the API
    // so it boots back into the active/sold-out state, not the closed window.
    if (snapshot !== null) {
      try {
        await setSaleWindow(config.mongodbUri, snapshot.startTime, snapshot.endTime);
      } catch (err) {
        console.error(
          `window-phase restore: could not write original window to MongoDB: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await restoreOpenWindow(config);
  }
}

/** Restore the compose-default (active) window so the stack is left usable, and
 *  PROVE it landed there before the harness can declare success. */
async function restoreOpenWindow(config: StressConfig): Promise<boolean> {
  if (compose(["up", "-d", "--force-recreate", "--wait", "api"]) !== 0) {
    return record("window restore", false, "docker compose could not restart the api on the default (open) window");
  }
  if (!(await waitForApi(config))) {
    return record("window restore", false, "the api never became ready after restoring the default window");
  }
  // Within [start, end) the status is "active" or "sold_out"; "upcoming" or
  // "ended" would mean the 2020 closed window is still in force.
  try {
    const res = await fetch(`${config.apiUrl}/api/sales/${SALE_SLUG}/status`, { signal: AbortSignal.timeout(2000) });
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
  k6SummaryRaw = readK6SummaryRaw();
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
    verifyReport = await runVerify(config);
    record("verifier", verifyReport.passed);
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

  const config = loadStressConfig();
  const reportPath = generateReport({
    phases,
    k6Raw: k6SummaryRaw,
    verifyReport,
    outDir: OUT_DIR,
    config: {
      attempts: config.attempts,
      vus: config.vus,
      stockQuantity: config.stockQuantity,
      apiUrl: config.apiUrl,
    },
  });
  if (reportPath !== undefined) {
    console.log(`Report: file://${reportPath}\n`);
    updateReadme(reportPath);
  }

  process.exit(failed.length === 0 ? 0 : 1);
}

/** Replace the content between <!-- stress:latest --> sentinels in README.md
 *  with a link to the report that just finished. Fail-safe — any error is
 *  logged and never propagates to the harness exit code. */
function updateReadme(reportPath: string): void {
  try {
    const readmePath = resolvePath(REPO_ROOT, "README.md");
    // Relative path from the repo root — works as a Markdown link on GitHub
    // once the docs/testing/stress/ tree is committed.
    const rel = reportPath.slice(REPO_ROOT.length + 1).replace(/\\/g, "/");
    const link = `**Latest stress report:** [${RUN_ID}](${rel})`;
    const OPEN = "<!-- stress:latest -->";
    const CLOSE = "<!-- /stress:latest -->";
    const content = readFileSync(readmePath, "utf8");
    const start = content.indexOf(OPEN);
    const end = content.indexOf(CLOSE);
    if (start === -1 || end === -1) return; // sentinels absent — skip silently
    const updated =
      content.slice(0, start + OPEN.length) + "\n" + link + "\n" + content.slice(end);
    writeFileSync(readmePath, updated, "utf8");
  } catch (err) {
    console.error(
      `[report] README update failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
