/**
 * Viewer-local h:mm AM/PM from an ISO-8601 string.
 * Server-side UTC still governs all enforcement; this is display only.
 *
 * Matches the contract used by StatusChip (which re-exports this) and
 * SaleStatusZone, so that every dynamic time label in the UI derives from
 * the same formatter — one change propagates everywhere.
 */
export function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
