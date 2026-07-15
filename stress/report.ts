// Generates stress/.out/<yyyymmdd_hhmm>/report.html after every harness run.
//
// Inputs  : harness phase array, raw k6-summary.json object, verifier report
// Output  : a single self-contained HTML file — no external deps, no CDN
//
// The generator is intentionally fail-safe: any error is caught and logged;
// it must never crash the harness or affect process.exit().
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { VerifyReport } from "./verify.ts";

export interface HarnessPhase {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ReportData {
  phases: HarnessPhase[];
  /** Full parsed k6-summary.json, or undefined if k6 never ran / file missing. */
  k6Raw: Record<string, unknown> | undefined;
  /** Verifier structured output, or undefined if the verifier was skipped. */
  verifyReport: VerifyReport | undefined;
  /** Run-time config values for the header card. */
  config: {
    attempts: number;
    vus: number;
    stockQuantity: number;
    apiUrl: string;
  };
  /** Absolute path to the timestamped output directory (stress/.out/yyyymmdd_hhmm).
   *  report.html is written here alongside k6-summary.json. */
  outDir: string;
}

// ─── k6 metric helpers ───────────────────────────────────────────────────────

type K6Metrics = Record<string, { values?: Record<string, number> }>;

function metrics(raw: Record<string, unknown>): K6Metrics {
  return (raw.metrics as K6Metrics | undefined) ?? {};
}

function count(m: K6Metrics, name: string): number {
  return m[name]?.values?.count ?? 0;
}

function pct(m: K6Metrics, name: string, p: string): number | undefined {
  return m[name]?.values?.[p];
}

function threshold(
  raw: Record<string, unknown>,
  name: string,
): { ok: boolean; stats: string }[] {
  const entry = (raw.thresholds as Record<string, unknown> | undefined)?.[name];
  if (!entry || typeof entry !== "object") return [];
  return Object.entries(entry as Record<string, unknown>).map(([condition, ok]) => ({
    ok: ok === true,
    stats: condition,
  }));
}

// ─── HTML primitives ─────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function badge(ok: boolean, size: "sm" | "lg" = "sm"): string {
  const cls = ok ? "pass" : "fail";
  const label = ok ? "PASS" : "FAIL";
  return `<span class="badge ${cls} ${size}">${label}</span>`;
}

function fmt(n: number | undefined, unit = ""): string {
  if (n === undefined) return "—";
  return `${n.toFixed(unit === "ms" ? 0 : 0)}${unit ? " " + unit : ""}`;
}

// ─── Section builders ─────────────────────────────────────────────────────────

function sectionPhases(phases: HarnessPhase[]): string {
  const rows = phases
    .map(
      (p) => `
      <tr>
        <td>${badge(p.ok)}</td>
        <td class="mono">${esc(p.name)}</td>
        <td class="detail">${p.detail ? esc(p.detail) : ""}</td>
      </tr>`,
    )
    .join("");
  return `
  <section>
    <h2>Phases</h2>
    <table>
      <thead><tr><th></th><th>Phase</th><th>Detail</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function sectionK6(raw: Record<string, unknown> | undefined): string {
  if (!raw) {
    return `<section><h2>k6 Metrics</h2><p class="muted">k6 did not run — no summary available.</p></section>`;
  }

  const m = metrics(raw);
  const c202 = count(m, "order_created_202");
  const c409 = count(m, "order_rejected_409");
  const c200 = count(m, "order_already_200");
  const c5xx = count(m, "order_5xx");
  const spam = count(m, "spam_wins_202");
  const p95 = pct(m, "http_req_duration", "p(95)");
  const p99 = pct(m, "http_req_duration", "p(99)");
  const total = count(m, "http_reqs");

  const cards = [
    { label: "202 Accepted", value: c202, cls: "green" },
    { label: "409 Rejected", value: c409, cls: "yellow" },
    { label: "200 Idempotent", value: c200, cls: "blue" },
    { label: "5xx Errors", value: c5xx, cls: c5xx > 0 ? "red" : "muted" },
    { label: "Total Requests", value: total, cls: "" },
    { label: "p95 Latency", value: `${fmt(p95)} ms`, cls: "" },
    { label: "p99 Latency", value: `${fmt(p99)} ms`, cls: "" },
    { label: "Spam Wins (≤1)", value: spam, cls: spam > 1 ? "red" : "muted" },
  ]
    .map(
      (c) => `
      <div class="card">
        <div class="card-value ${c.cls}">${esc(c.value)}</div>
        <div class="card-label">${esc(c.label)}</div>
      </div>`,
    )
    .join("");

  // Threshold table — pull every threshold k6 tracked
  const thresholdNames = [
    "http_req_failed",
    "unexpected_status",
    "spam_wins_202",
    `http_req_duration{name:'POST /api/sales/:slug/order'}`,
  ];
  const thresholdRows = thresholdNames.flatMap((name) => {
    const entries = threshold(raw, name);
    return entries.map(
      (e) => `
        <tr>
          <td>${badge(e.ok)}</td>
          <td class="mono">${esc(name)}</td>
          <td class="mono">${esc(e.stats)}</td>
        </tr>`,
    );
  });

  const thresholdSection =
    thresholdRows.length > 0
      ? `
      <h3>Thresholds</h3>
      <table>
        <thead><tr><th></th><th>Metric</th><th>Condition</th></tr></thead>
        <tbody>${thresholdRows.join("")}</tbody>
      </table>`
      : "";

  return `
  <section>
    <h2>k6 Metrics</h2>
    <div class="cards">${cards}</div>
    ${thresholdSection}
  </section>`;
}

function sectionVerifier(vr: VerifyReport | undefined): string {
  if (!vr) {
    return `<section><h2>Verifier</h2><p class="muted">Verifier was skipped (k6 runner failed).</p></section>`;
  }

  const { observed, results } = vr;
  const obsRows = [
    ["SCARD orders:{saleId}:users (accepted)", observed.orderUsers],
    ["stock:{saleId}:remaining", observed.stockRemaining ?? "⟨key missing⟩"],
    ["Mongo confirmed orders", observed.orders],
    ["Mongo distinct emails", observed.distinctEmails],
    ["API seeded stockQuantity", observed.apiStockQuantity],
  ]
    .map(
      ([label, val]) => `
      <tr><td>${esc(label)}</td><td class="mono">${esc(val)}</td></tr>`,
    )
    .join("");

  const checkRows = results
    .map(
      (r) => `
      <tr>
        <td>${badge(r.pass)}</td>
        <td>${esc(r.name)}</td>
        <td class="mono">${esc(r.expected)}</td>
        <td class="mono">${esc(r.actual)}</td>
        <td class="detail">${r.note ? esc(r.note) : ""}</td>
      </tr>`,
    )
    .join("");

  return `
  <section>
    <h2>Verifier ${badge(vr.passed)}</h2>
    <h3>Observed values</h3>
    <table>
      <thead><tr><th>Metric</th><th>Value</th></tr></thead>
      <tbody>${obsRows}</tbody>
    </table>
    <h3>Assertions</h3>
    <table>
      <thead><tr><th></th><th>Check</th><th>Expected</th><th>Actual</th><th>Note</th></tr></thead>
      <tbody>${checkRows}</tbody>
    </table>
  </section>`;
}

function sectionRaw(raw: Record<string, unknown> | undefined): string {
  if (!raw) return "";
  return `
  <section>
    <details>
      <summary>Raw k6-summary.json</summary>
      <pre class="raw">${esc(JSON.stringify(raw, null, 2))}</pre>
    </details>
  </section>`;
}

// ─── CSS ─────────────────────────────────────────────────────────────────────

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #7d8590;
    --green: #3fb950; --red: #f85149; --yellow: #d29922; --blue: #58a6ff;
  }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.6; padding: 32px 24px; }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
  h2 { font-size: 16px; font-weight: 600; margin: 32px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  h3 { font-size: 13px; font-weight: 600; margin: 20px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  section { max-width: 960px; margin: 0 auto; }
  header { max-width: 960px; margin: 0 auto 8px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .meta { color: var(--muted); font-size: 12px; margin-bottom: 24px; max-width: 960px; margin-left: auto; margin-right: auto; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th { text-align: left; padding: 6px 10px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); border-bottom: 1px solid var(--border); }
  td { padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .mono { font-family: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, monospace; font-size: 12px; }
  .detail { color: var(--muted); font-size: 12px; max-width: 400px; }
  .muted { color: var(--muted); }
  .badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 4px; letter-spacing: .04em; }
  .badge.pass { background: #1a3a24; color: var(--green); }
  .badge.fail { background: #3a1a1a; color: var(--red); }
  .badge.lg { font-size: 15px; padding: 3px 14px; border-radius: 6px; }
  .cards { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px 18px; min-width: 130px; }
  .card-value { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.2; }
  .card-label { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .green { color: var(--green); }
  .red { color: var(--red); }
  .yellow { color: var(--yellow); }
  .blue { color: var(--blue); }
  details summary { cursor: pointer; padding: 8px 0; font-size: 13px; color: var(--muted); user-select: none; }
  details summary:hover { color: var(--text); }
  pre.raw { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 16px; overflow: auto; font-size: 11px; font-family: ui-monospace, monospace; white-space: pre; color: var(--muted); margin-top: 8px; max-height: 500px; }
`;

// ─── Main export ─────────────────────────────────────────────────────────────

export function generateReport(data: ReportData): string | undefined {
  try {
    const { phases, k6Raw, verifyReport, config, outDir } = data;
    const overallOk = phases.every((p) => p.ok);
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Stress Report — ${ts}</title>
  <style>${CSS}</style>
</head>
<body>
  <header>
    <h1>Stress Test Report</h1>
    ${badge(overallOk, "lg")}
  </header>
  <p class="meta">
    ${ts} &nbsp;·&nbsp;
    ${config.attempts.toLocaleString()} attempts &nbsp;·&nbsp;
    ${config.vus} VUs &nbsp;·&nbsp;
    STOCK_QUANTITY=${config.stockQuantity} &nbsp;·&nbsp;
    ${esc(config.apiUrl)}
  </p>

  ${sectionPhases(phases)}
  ${sectionK6(k6Raw)}
  ${sectionVerifier(verifyReport)}
  ${sectionRaw(k6Raw)}
</body>
</html>`;

    mkdirSync(outDir, { recursive: true });
    const outPath = resolvePath(outDir, "report.html");
    writeFileSync(outPath, html, "utf8");
    return outPath;
  } catch (err) {
    console.error(
      `[report] failed to write HTML report: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
