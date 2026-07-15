/**
 * Deterministic, relative sale-window constants used across all server test files.
 *
 * Values are arbitrary epoch-ms offsets chosen so that:
 *   BEFORE_START < START_MS < IN_WINDOW < END_MS < AFTER_END
 *
 * Tests never call Date.now() directly — the injected `clock` seam always
 * receives one of these constants — so the window never "expires" in real
 * calendar time and the dates are unambiguously fake.
 */

export const START_MS = 1_000_000; // arbitrary epoch-ms (~16 min after Unix epoch)
export const END_MS = 4_600_000; // START_MS + 1 hour (3_600_000 ms)
export const IN_WINDOW = START_MS + 1_000; // 1 s into the window
export const BEFORE_START = START_MS - 1;
export const AFTER_END = END_MS + 60_000;

export const START_ISO = new Date(START_MS).toISOString(); // "1970-01-01T00:16:40.000Z"
export const END_ISO = new Date(END_MS).toISOString(); // "1970-01-01T01:16:40.000Z"

/** Drop-in replacement for the `window` / `SaleWindow` object used in tests. */
export const WINDOW = {
  startMs: START_MS,
  endMs: END_MS,
  startIso: START_ISO,
  endIso: END_ISO,
};
