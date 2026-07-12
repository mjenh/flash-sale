// The judge (SM-1, SM-2, SM-C1, NFR-11/12/16/18).
//
// k6's thresholds prove the SHAPE of the responses (no 5xx, nothing outside
// {201, 409}). The exact-count claims are asserted here, against the stores,
// because those are the claims the PRD actually makes:
//
//   confirmed orders == min(STOCK_QUANTITY, attempts)      (SM-1 / NFR-11)
//   distinct emails  == confirmed orders                   (SM-2 / NFR-12)
//   SCARD orders:users == confirmed orders
//   stock:remaining  == STOCK_QUANTITY - confirmed orders  (NFR-18)
//
// Every check is an EQUALITY. There is no `<=` anywhere in this file — that is
// how SM-C1 (under-accepting is also a bug) is enforced: 99 orders out of 5,000
// attempts against stock 100 fails exactly as loudly as 101 would.
//
// The Mongo write is async by design (AD-3), so the count is polled until it is
// stable across two 1 s samples. A fixed sleep would fail a correct system.
import { createClient } from "redis";
import mongoose from "mongoose";
import { loadStressConfig, SALE_SLUG, type StressConfig } from "./config.ts";
import { ORDERS_KEY, STOCK_KEY } from "./reset.ts";

export interface Observed {
  /** Confirmed Order documents for the sale. */
  orders: number;
  /** Distinct `email` values among those orders. */
  distinctEmails: number;
  /** SCARD orders:users. */
  orderUsers: number;
  /** GET stock:remaining — null when the key is missing (never coerce to 0). */
  stockRemaining: number | null;
}

export interface Expected {
  stockQuantity: number;
  attempts: number;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
  note?: string;
}

/** The whole assertion engine, pure — every branch is unit-tested without I/O. */
export function evaluate(observed: Observed, expected: Expected): CheckResult[] {
  const target = Math.min(expected.stockQuantity, expected.attempts);
  const { orders, distinctEmails, orderUsers, stockRemaining } = observed;

  const oversell = orders > target;
  const underAccept = orders < target;

  return [
    {
      name: "SM-1  confirmed orders == min(STOCK_QUANTITY, attempts)",
      pass: orders === target,
      expected: String(target),
      actual: String(orders),
      note: oversell
        ? "OVERSOLD — the one inviolable invariant is broken (NFR-1)"
        : underAccept
          ? "UNDER-ACCEPTED — an inflated rejection rate is also a bug (SM-C1/NFR-16)"
          : undefined,
    },
    {
      name: "SM-2  distinct emails == confirmed orders",
      pass: distinctEmails === orders,
      expected: String(orders),
      actual: String(distinctEmails),
      note: distinctEmails === orders ? undefined : "a duplicate order reached the audit trail",
    },
    {
      name: `      SCARD ${ORDERS_KEY} == confirmed orders`,
      pass: orderUsers === orders,
      expected: String(orders),
      actual: String(orderUsers),
      note:
        orderUsers === orders
          ? undefined
          : "Redis and Mongo disagree — an accepted order never reached the audit (NFR-4 undercount) or Mongo holds an order Redis never accepted",
    },
    {
      name: `      ${STOCK_KEY} == STOCK_QUANTITY - confirmed orders`,
      pass: stockRemaining !== null && stockRemaining === expected.stockQuantity - orders,
      expected: String(expected.stockQuantity - orders),
      actual: stockRemaining === null ? "<key missing>" : String(stockRemaining),
      note:
        stockRemaining === null
          ? "stock:remaining is absent — the harness never fabricates a 0 (a fabricated 0 reads as a clean sell-out)"
          : undefined,
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

/** AD-3 drain: poll until two consecutive 1 s samples agree. Bounded — a count
 *  that never settles is a failure with that exact message, not a hang. */
export async function pollUntilStable(
  ports: SamplePorts,
  { intervalMs = 1000, maxSamples = 30, sleep = defaultSleep }: PollOptions = {},
): Promise<number> {
  let previous = await ports.countOrders();
  for (let i = 1; i < maxSamples; i += 1) {
    await sleep(intervalMs);
    const current = await ports.countOrders();
    if (current === previous) {
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
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const filter = { saleId: sale._id, status: "confirmed" };

    const orders = await pollUntilStable({
      countOrders: () => db.collection("orders").countDocuments(filter),
    });
    const distinctEmails = (await db.collection("orders").distinct("email", filter)).length;
    const orderUsers = await redis.sCard(ORDERS_KEY);
    const rawStock = await redis.get(STOCK_KEY);

    return {
      orders,
      distinctEmails,
      orderUsers,
      stockRemaining: rawStock === null ? null : Number.parseInt(rawStock, 10),
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
