// The one command (NFR-18, NFR-20): `npm run stress` / `make stress`.
//
// The protocol, in the only order that is honest:
//   stop API → reset → start API → k6 → verifier → (window phase)
//
// - Reset while the API serves would race the AD-1 Lua script's sole-writer rule.
// - The API restarts AFTER the wipe so AD-4's boot rebuild re-establishes a
//   clean, boot-verified state.
// - The verifier runs LAST and polls, because the Mongo audit write is async
//   by design (AD-3).
//
// Every phase prints as it starts and hard-fails the run on error. The combined
// exit code is the pass/fail signal: 0 only when every phase passed.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { loadStressConfig, type StressConfig } from "./config.ts";
import { runReset } from "./reset.ts";
import { runVerify } from "./verify.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..");

const skipWindow = process.argv.includes("--skip-window");

interface Phase {
  name: string;
  ok: boolean;
  detail?: string;
}

const phases: Phase[] = [];

function announce(name: string): void {
  console.log(`\n=== ${name} ===`);
}

function record(name: string, ok: boolean, detail?: string): boolean {
  phases.push({ name, ok, detail });
  return ok;
}

function compose(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const res = spawnSync("docker", ["compose", ...args], {
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
    } catch {
      return true; // connection refused — nothing is listening
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

/** SM-3 / NFR-13: attempts outside the window are ALL rejected with
 *  { success: false }. The window is boot-parsed config (AD-6), so the only
 *  honest way to prove this against the deployed stack is to restart the API
 *  with a past window and knock on the door. */
async function windowPhase(config: StressConfig): Promise<boolean> {
  const closed = {
    ...process.env,
    SALE_START_TIME: "2020-01-01T00:00:00Z",
    SALE_END_TIME: "2020-01-02T00:00:00Z",
  };
  if (compose(["up", "-d", "api"], closed) !== 0) {
    return record("window phase (SM-3)", false, "could not restart the api with a closed window");
  }
  if (!(await waitForApi(config))) {
    return record("window phase (SM-3)", false, "api never became ready with the closed window");
  }

  const failures: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const res = await fetch(`${config.apiUrl}/api/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `window-${Date.now()}-${i}@example.com` }),
    });
    const body = (await res.json()) as { success?: unknown; error?: unknown };
    if (res.status !== 409 || body.success !== false || body.error !== "Sale is not active.") {
      failures.push(`attempt ${i}: HTTP ${res.status} ${JSON.stringify(body)}`);
    }
  }

  // Restore the compose-default (active) window so the stack is left usable.
  compose(["up", "-d", "api"]);

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    return record(
      "window phase (SM-3)",
      false,
      `${failures.length}/20 out-of-window attempts were not rejected with 409 { success: false, error: "Sale is not active." }`,
    );
  }
  console.log('20/20 out-of-window attempts rejected: 409 { success: false, error: "Sale is not active." }');
  return record("window phase (SM-3)", true);
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
    console.log(`stock:remaining = ${result.stockQuantity}; cleared ${result.cleared.join(", ")}`);
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

  if (skipWindow) {
    console.log("\n=== 6/6 window phase — SKIPPED (--skip-window) ===");
  } else {
    announce("6/6 window phase (SM-3)");
    await windowPhase(config);
  }

  finish();
}

function finish(): void {
  const failed = phases.filter((p) => !p.ok);
  console.log("\n──────── stress harness ────────");
  for (const p of phases) {
    console.log(`${p.ok ? "PASS" : "FAIL"}  ${p.name}${p.detail === undefined ? "" : `\n      ${p.detail}`}`);
  }
  console.log(failed.length === 0 ? "\nPASS — the fairness claim holds.\n" : `\nFAIL — ${failed.length} phase(s) failed.\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
