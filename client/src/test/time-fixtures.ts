/**
 * Deterministic date-string constants for client test fixtures.
 *
 * Mirrors server/test/helpers/time-fixtures.ts — the same arbitrary
 * epoch-ms values, expressed as ISO strings for use in mock response bodies.
 * Tests that use these strings never call Date.now() directly, so the dates
 * cannot "expire" in real calendar time.
 */

export const START_MS = 1_000_000;
export const END_MS = 4_600_000;

export const START_ISO = new Date(START_MS).toISOString(); // "1970-01-01T00:16:40.000Z"
export const END_ISO = new Date(END_MS).toISOString(); // "1970-01-01T01:16:40.000Z"
