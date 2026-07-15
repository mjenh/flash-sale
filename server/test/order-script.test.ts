// Loaded through the SAME loader production uses (ORDER_SCRIPT_SOURCE). Pins
// the ARGV shape, commands, and mutation ordering so the .lua file and the
// test fake's JS port cannot drift silently.
//
// Story 4.2: the script no longer receives KEYS[] — it receives
// ARGV = [saleId, email] and constructs `orders:{saleId}:users` /
// `stock:{saleId}:remaining` internally.
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

  it("addresses exactly ARGV[1] (saleId) and ARGV[2] (email) — no KEYS[] at all", () => {
    expect(stripped).toContain("ARGV[1]");
    expect(stripped).toContain("ARGV[2]");
    expect(stripped).not.toMatch(/ARGV\[[3-9]\]/);
    // Story 4.2 AC2: key construction moved INSIDE the script — no KEYS[]
    // reference anywhere, and no hardcoded v1.0 flat key names.
    expect(stripped).not.toContain("KEYS[");
    expect(stripped).not.toContain("'orders:users'");
    expect(stripped).not.toContain("'stock:remaining'");
  });

  it("constructs the sale-scoped key names from ARGV[1] via string concatenation", () => {
    expect(stripped).toContain("'orders:' .. saleId .. ':users'");
    expect(stripped).toContain("'stock:' .. saleId .. ':remaining'");
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
