// The judge, proven with fakes. The load-bearing case is the SM-C1 one:
// 99 orders must fail exactly as loudly as 101.
import { describe, expect, it, vi } from "vitest";
import { evaluate, passed, pollUntilStable, type Observed } from "../verify.ts";

const EXPECTED = { stockQuantity: 100, attempts: 5000 };

function observed(over: Partial<Observed> = {}): Observed {
  return {
    orders: 100,
    distinctEmails: 100,
    orderUsers: 100,
    stockRemaining: 0,
    ...over,
  };
}

describe("evaluate", () => {
  it("passes the exact 5,000-vs-100 run", () => {
    const results = evaluate(observed(), EXPECTED);

    expect(passed(results)).toBe(true);
    expect(results).toHaveLength(4);
  });

  it("fails an oversell (101 orders against stock 100)", () => {
    const results = evaluate(
      observed({ orders: 101, distinctEmails: 101, orderUsers: 101, stockRemaining: -1 }),
      EXPECTED,
    );

    expect(passed(results)).toBe(false);
    expect(results[0]?.pass).toBe(false);
    expect(results[0]?.note).toContain("OVERSOLD");
  });

  it("fails an under-accept (99 orders) — SM-C1: an inflated rejection rate is also a bug", () => {
    const results = evaluate(
      observed({ orders: 99, distinctEmails: 99, orderUsers: 99, stockRemaining: 1 }),
      EXPECTED,
    );

    expect(passed(results)).toBe(false);
    expect(results[0]?.pass).toBe(false);
    expect(results[0]?.note).toContain("UNDER-ACCEPTED");
  });

  it("fails when Redis and Mongo disagree (SCARD 100, orders 99)", () => {
    const results = evaluate(
      observed({ orders: 99, distinctEmails: 99, orderUsers: 100, stockRemaining: 1 }),
      EXPECTED,
    );

    expect(passed(results)).toBe(false);
    expect(results[2]?.pass).toBe(false);
  });

  it("fails on a duplicate email in the audit trail (SM-2)", () => {
    const results = evaluate(observed({ distinctEmails: 99 }), EXPECTED);

    expect(passed(results)).toBe(false);
    expect(results[1]?.pass).toBe(false);
    expect(results[1]?.note).toContain("duplicate");
  });

  it("fails when stock:remaining is off by one", () => {
    const results = evaluate(observed({ stockRemaining: 1 }), EXPECTED);

    expect(passed(results)).toBe(false);
    expect(results[3]?.pass).toBe(false);
  });

  it("fails — never passes as 0 — when stock:remaining is missing", () => {
    const results = evaluate(observed({ stockRemaining: null }), EXPECTED);

    expect(passed(results)).toBe(false);
    expect(results[3]?.actual).toBe("<key missing>");
    expect(results[3]?.note).toContain("never fabricates a 0");
  });

  it("targets min(STOCK_QUANTITY, attempts) when fewer buyers than units attend", () => {
    const results = evaluate(
      observed({ orders: 40, distinctEmails: 40, orderUsers: 40, stockRemaining: 60 }),
      { stockQuantity: 100, attempts: 40 },
    );

    expect(passed(results)).toBe(true);
  });
});

describe("pollUntilStable", () => {
  it("returns the count once two consecutive samples agree (the AD-3 async drain)", async () => {
    const counts = [40, 88, 100, 100];
    let i = 0;

    const stable = await pollUntilStable(
      { countOrders: async () => counts[i++] ?? 100 },
      { intervalMs: 0, sleep: async () => {} },
    );

    expect(stable).toBe(100);
    expect(i).toBe(4);
  });

  it("fails — rather than hangs — when the count never settles", async () => {
    let n = 0;

    await expect(
      pollUntilStable(
        { countOrders: async () => (n += 1) },
        { intervalMs: 0, maxSamples: 5, sleep: async () => {} },
      ),
    ).rejects.toThrow(/never settled/);
  });

  it("sleeps between samples", async () => {
    const sleep = vi.fn(async () => {});

    await pollUntilStable({ countOrders: async () => 100 }, { intervalMs: 1000, sleep });

    expect(sleep).toHaveBeenCalledWith(1000);
  });
});
