// The judge.
//
// k6's thresholds prove the SHAPE of the responses (no 5xx, nothing outside
// {201, 409}). The exact-count claims are asserted here, against the stores.
//
// The authority is Redis, which the Lua script writes atomically:
//
//   SCARD orders:{saleId}:users == min(API stockQuantity, attempts)
//   distinct emails             == confirmed (Mongo) orders
//   stock:{saleId}:remaining    == API stockQuantity - SCARD
//
// The stock BASIS is the API's own seeded `sales.stockQuantity`, cross-checked
// against the harness config — the verifier never marks its own homework by
// asserting against a number the harness chose. The same seeded sale document
// also resolves {saleId} (Story 4.6) for the namespaced Redis keys below.
//
// The fairness equalities keep a no-`<=` discipline: 99 accepts out of 5,000
// against stock 100 fails as loudly as 101. The ONE place a tolerance is
// allowed is the Mongo audit reconciliation: the async audit is accepted to
// undercount, so an undercount within a stated tolerance passes with a note,
// while an OVERCOUNT — Mongo holding an order Redis never accepted — is always
// a hard fail.
//
// The Mongo write is async by design, so the count is polled until it is stable
// across two 1 s samples on a NON-ZERO plateau (a 0 == 0 before the drain
// begins is not a settled count). A fixed sleep would fail a correct system.
import { createClient } from "redis";
import mongoose from "mongoose";
import { loadStressConfig, SALE_SLUG, type StressConfig } from "./config.ts";
import { ordersKeyFor, stockKeyFor } from "./reset.ts";

export interface Observed {
  /** Confirmed Order documents for the sale — the async Mongo audit,
   *  which is accepted to undercount. Never the fairness authority. */
  orders: number;
  /** Distinct `email` values among those Mongo orders. */
  distinctEmails: number;
  /** SCARD orders:{saleId}:users — the authoritative record of who was
   *  accepted. Redis membership is the fairness truth; Mongo is the
   *  downstream audit. */
  orderUsers: number;
  /** GET stock:{saleId}:remaining — null when the key is missing (never
   *  coerce to 0). */
  stockRemaining: number | null;
  /** The API's own seeded `sales.stockQuantity` — the single source of truth
   *  for how many units the sale ran with. The harness must NOT mark
   *  its own homework by asserting against a number it chose. */
  apiStockQuantity: number;
}

export interface Expected {
  /** The harness-configured STOCK_QUANTITY — used ONLY to cross-check against
   *  the API's seeded value, never as the assertion basis. */
  stockQuantity: number;
  attempts: number;
  /** Max accepted Mongo audit undercount vs Redis before it becomes a failure
   *  Defaults to max(1, 1% of target). */
  auditTolerance?: number;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
  note?: string;
}

/** The whole assertion engine, pure — every branch is unit-tested without I/O.
 *  Deliberately saleId-agnostic (Observed/Expected carry only counts, never
 *  key names) so it stays testable without a resolved sale — the report
 *  labels below name the KEY SCHEME (`{saleId}` as a literal placeholder),
 *  not any one run's actual key.
 *
 *  The fairness invariants key off Redis (SCARD orders:{saleId}:users +
 *  stock:{saleId}:remaining), which is the authority the Lua script writes
 *  atomically. The Mongo audit is reconciled with a tolerance: an undercount
 *  is an accepted, documented
 *  property and passes with a note; an OVERCOUNT (Mongo holds an order Redis
 *  never accepted — a phantom) is always a hard fail. The stock basis is the
 *  API's own seeded quantity. */
export function evaluate(observed: Observed, expected: Expected): CheckResult[] {
  const { orders, distinctEmails, orderUsers, stockRemaining, apiStockQuantity } = observed;

  // Redis SCARD is the authoritative count of accepted orders.
  const accepted = orderUsers;
  const target = Math.min(apiStockQuantity, expected.attempts);
  const tolerance = expected.auditTolerance ?? Math.max(1, Math.ceil(target * 0.01));

  const oversell = accepted > target;
  const underAccept = accepted < target;

  const auditUnder = accepted - orders; // > 0 undercount, < 0 overcount
  const auditPass = orders <= accepted && auditUnder <= tolerance;

  return [
    {
      name: "accepted orders (SCARD) == min(API stockQuantity, attempts)",
      pass: accepted === target,
      expected: String(target),
      actual: String(accepted),
      note: oversell
        ? "OVERSOLD — the one inviolable invariant is broken"
        : underAccept
          ? "UNDER-ACCEPTED — an inflated rejection rate is also a bug"
          : undefined,
    },
    {
      name: "distinct emails == confirmed (Mongo) orders",
      pass: distinctEmails === orders,
      expected: String(orders),
      actual: String(distinctEmails),
      note: distinctEmails === orders ? undefined : "a duplicate order reached the audit trail",
    },
    {
      name: `      Mongo audit orders vs SCARD orders:{saleId}:users (undercount tolerance ${tolerance})`,
      pass: auditPass,
      expected: `${accepted} (undercount up to ${tolerance} accepted; overcount forbidden)`,
      actual: String(orders),
      note:
        orders > accepted
          ? "OVERCOUNT — Mongo holds a confirmed order Redis never accepted: a phantom order (hard fail)"
          : auditUnder === 0
            ? undefined
            : auditUnder <= tolerance
              ? `audit undercount of ${auditUnder} within tolerance — an accepted property (a Redis accept whose async Mongo write was lost); Redis remains the authoritative fairness record`
              : `audit undercount of ${auditUnder} EXCEEDS tolerance ${tolerance} — too many accepted orders never reached the audit`,
    },
    {
      name: "      stock:{saleId}:remaining == API stockQuantity - accepted (SCARD)",
      pass: stockRemaining !== null && stockRemaining === apiStockQuantity - accepted,
      expected: String(apiStockQuantity - accepted),
      actual: stockRemaining === null ? "<key missing>" : String(stockRemaining),
      note:
        stockRemaining === null
          ? "stock:{saleId}:remaining is absent — the harness never fabricates a 0 (a fabricated 0 reads as a clean sell-out)"
          : undefined,
    },
    {
      name: "harness STOCK_QUANTITY == API seeded sales.stockQuantity",
      pass: expected.stockQuantity === apiStockQuantity,
      expected: String(apiStockQuantity),
      actual: String(expected.stockQuantity),
      note:
        expected.stockQuantity === apiStockQuantity
          ? undefined
          : "the harness expected a different stock than the API booted with — the API's seeded value is authoritative; a disagreement means the run's stock was not what the verifier assumed",
    },
  ];
}

export function passed(results: readonly CheckResult[]): boolean {
  return results.every((r) => r.pass);
}

export function formatResults(results: readonly CheckResult[]): string {
  return results
    .map((r) => {
      const head = `${r.pass ? "PASS" : "FAIL"}  ${r.name}\n        expected ${r.expected} · actual ${r.actual}`;
      return r.note === undefined ? head : `${head}\n        ${r.note}`;
    })
    .join("\n");
}

export interface SamplePorts {
  countOrders(): Promise<number>;
}

/** Async drain: poll until two consecutive 1 s samples agree on a NON-ZERO,
 *  settled count. Bounded — a count that never settles is a failure with that
 *  exact message, not a hang.
 *
 *  The non-zero + minimum-sample floor exists because a naive
 *  "two consecutive samples agree" settles on the 0 == 0 that precedes the very
 *  first audit write — a plateau that never started — and reports a false
 *  UNDER-ACCEPTED against a database the drain has not yet reached. A correct
 *  run always confirms at least one order, so a genuine non-zero plateau is the
 *  only honest settle. */
export async function pollUntilStable(
  ports: SamplePorts,
  { intervalMs = 1000, maxSamples = 30, minSamples = 3, sleep = defaultSleep }: PollOptions = {},
): Promise<number> {
  let previous = await ports.countOrders();
  for (let i = 1; i < maxSamples; i += 1) {
    await sleep(intervalMs);
    const current = await ports.countOrders();
    if (current === previous && current > 0 && i >= minSamples) {
      return current;
    }
    previous = current;
  }
  throw new Error(
    `audit writes never settled: the confirmed-order count was still moving after ${maxSamples} samples`,
  );
}

export interface PollOptions {
  intervalMs?: number;
  maxSamples?: number;
  /** Minimum samples before a plateau may settle — guards against settling on a
   *  pre-drain 0 == 0. */
  minSamples?: number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strict integer parse for `stock:{saleId}:remaining`. `Number.parseInt`
 *  truncates trailing garbage — `"100abc" -> 100` — which could accidentally
 *  equal the expected value and pass a corrupt run. A non-integer yields `NaN`,
 *  which fails the equality check loudly instead of reading as a clean value. */
function parseStockValue(raw: string): number {
  return /^-?\d+$/.test(raw.trim()) ? Number.parseInt(raw, 10) : Number.NaN;
}

export async function observe(config: StressConfig): Promise<Observed> {
  const redis = createClient({ url: config.redisUrl, disableOfflineQueue: true });
  redis.on("error", () => {});
  await redis.connect();
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });

  try {
    const db = mongoose.connection.db;
    if (db === undefined) {
      throw new Error("Mongo connection has no database handle");
    }

    const sale = await db.collection("sales").findOne({ slug: SALE_SLUG });
    if (sale === null) {
      throw new Error(
        `no sale document with slug "${SALE_SLUG}" — the API never booted against ${config.mongodbUri}`,
      );
    }
    // The API's own seeded quantity is the authoritative stock basis —
    // read it, never assume the harness's configured value matches it.
    const apiStockQuantity = (sale as { stockQuantity?: unknown }).stockQuantity;
    if (typeof apiStockQuantity !== "number" || !Number.isInteger(apiStockQuantity)) {
      throw new Error(
        `sale document "${SALE_SLUG}" has no integer stockQuantity — cannot establish the authoritative stock basis`,
      );
    }
    // Story 4.6: the resolved sale's own Mongo ObjectId string is {saleId} —
    // the same identity server/src/adapters/redis namespaces its keys by.
    const saleId = String(sale._id);
    const filter = { saleId: sale._id, status: "confirmed" };

    const orders = await pollUntilStable({
      countOrders: () => db.collection("orders").countDocuments(filter),
    });
    const distinctEmails = (await db.collection("orders").distinct("email", filter)).length;
    const orderUsers = await redis.sCard(ordersKeyFor(saleId));
    const rawStock = await redis.get(stockKeyFor(saleId));

    return {
      orders,
      distinctEmails,
      orderUsers,
      stockRemaining: rawStock === null ? null : parseStockValue(rawStock),
      apiStockQuantity,
    };
  } finally {
    await redis.close();
    await mongoose.disconnect();
  }
}

export async function runVerify(config: StressConfig = loadStressConfig()): Promise<boolean> {
  const observed = await observe(config);
  const results = evaluate(observed, {
    stockQuantity: config.stockQuantity,
    attempts: config.attempts,
  });

  console.log(
    `\nverifier — ${config.attempts} attempts against STOCK_QUANTITY=${config.stockQuantity}\n`,
  );
  console.log(formatResults(results));
  const ok = passed(results);
  console.log(`\n${ok ? "VERIFIER PASSED" : "VERIFIER FAILED"}\n`);
  return ok;
}

/** `node verify.ts` entry point (also invoked in-process by run.ts). */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  try {
    const ok = await runVerify();
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error(`verifier FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
