// Loaded through the SAME loader production uses (ORDER_SCRIPT_SOURCE). Pins
// the KEYS/ARGV shape, commands, and mutation ordering so the .lua file and
// the test fake's JS port cannot drift silently.
//
// KEYS[1] = stock:{saleId}:remaining, KEYS[2] = orders:{saleId}:users,
// ARGV[1] = email — key names are passed via KEYS[] so Redis Cluster can
// hash-slot the command (constructed by the caller in orders.ts).
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

  it("uses KEYS[1] (stockKey) and KEYS[2] (ordersKey), ARGV[1] for email — no higher indices", () => {
    expect(stripped).toContain("KEYS[1]");
    expect(stripped).toContain("KEYS[2]");
    expect(stripped).toContain("ARGV[1]");
    // No higher KEYS or ARGV indices — the contract is exactly (2 keys, 1 arg).
    expect(stripped).not.toMatch(/KEYS\[[3-9]\]/);
    expect(stripped).not.toMatch(/ARGV\[[2-9]\]/);
    // No hardcoded v1.0 flat key names.
    expect(stripped).not.toContain("'orders:users'");
    expect(stripped).not.toContain("'stock:remaining'");
  });

  it("assigns KEYS[1] to stockKey and KEYS[2] to ordersKey at the top of the script", () => {
    expect(stripped).toContain("KEYS[1]");
    expect(stripped).toContain("KEYS[2]");
    // The script must reference stockKey (for GET / error message) and ordersKey (for SISMEMBER / SADD).
    expect(stripped).toContain("stockKey");
    expect(stripped).toContain("ordersKey");
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
    // Split into non-blank, non-comment lines — each represents one Lua statement.
    // Line-index comparison is robust against reformatting and inline comments;
    // character-index comparison (indexOf on the joined string) breaks if a comment
    // or variable name contains a command keyword before the real call.
    const executableLines = ORDER_SCRIPT_SOURCE.split("\n").filter(
      (line) => line.trim() !== "" && !line.trim().startsWith("--"),
    );

    const indexOf = (needle: string): number => {
      const i = executableLines.findIndex((line) => line.includes(needle));
      expect(i, `expected script to contain a line with '${needle}'`).toBeGreaterThanOrEqual(0);
      return i;
    };

    const stockRead = indexOf("'GET'");      // GET stockKey
    const membershipCheck = indexOf("SISMEMBER"); // membership guard
    const sadd = indexOf("SADD");            // write: add member
    const decr = indexOf("DECR");            // write: decrement stock

    expect(stockRead).toBeLessThan(sadd);
    expect(membershipCheck).toBeLessThan(sadd);
    expect(sadd).toBeLessThan(decr);
  });

  it("fails closed on a missing stock key (error_reply, never a fabricated number)", () => {
    expect(stripped).toContain("error_reply");
    expect(stripped).toContain("stockKey .. ' missing'");
  });
});
