// Loaded through the SAME loader production uses (ORDER_SCRIPT_SOURCE). Pins
// the keys, commands, and mutation ordering so the .lua file and the test
// fake's JS port cannot drift silently.
import { describe, expect, it } from "vitest";
import { ORDER_SCRIPT_SOURCE } from "../src/adapters/redis/orders.ts";

describe("order.lua (authoritative source)", () => {
  const stripped = ORDER_SCRIPT_SOURCE.split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  it("loads a non-empty script through the production loader", () => {
    expect(ORDER_SCRIPT_SOURCE.length).toBeGreaterThan(0);
    expect(ORDER_SCRIPT_SOURCE).toContain("order.lua");
  });

  it("addresses exactly KEYS[1] (orders:users), KEYS[2] (stock:remaining), ARGV[1] (email)", () => {
    expect(stripped).toContain("KEYS[1]");
    expect(stripped).toContain("KEYS[2]");
    expect(stripped).toContain("ARGV[1]");
    expect(stripped).not.toMatch(/KEYS\[[3-9]\]/);
    expect(stripped).not.toMatch(/ARGV\[[2-9]\]/);
    // Key NAMES never appear in the script — they arrive via KEYS (adapter-owned).
    expect(stripped).not.toContain("orders:users");
  });

  it("contains the four decision commands and the three verdicts", () => {
    for (const command of ["GET", "SISMEMBER", "SADD", "DECR"]) {
      expect(stripped).toContain(`'${command}'`);
    }
    for (const verdict of ["'OK'", "'ALREADY'", "'SOLD_OUT'"]) {
      expect(stripped).toContain(verdict);
    }
  });

  it("mutates (SADD, DECR) only after the membership and stock checks", () => {
    const idx = (needle: string): number => {
      const at = stripped.indexOf(needle);
      expect(at, `expected script to contain ${needle}`).toBeGreaterThanOrEqual(0);
      return at;
    };
    const membershipCheck = idx("SISMEMBER");
    const stockRead = idx("'GET'");
    const sadd = idx("SADD");
    const decr = idx("DECR");
    expect(stockRead).toBeLessThan(sadd);
    expect(membershipCheck).toBeLessThan(sadd);
    expect(sadd).toBeLessThan(decr);
  });

  it("fails closed on a missing stock key (error_reply, never a fabricated number)", () => {
    expect(stripped).toContain("error_reply");
    expect(stripped).toContain("stock:remaining missing");
  });
});
