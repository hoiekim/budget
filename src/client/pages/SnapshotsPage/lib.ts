import { getDateString } from "common";

/** Render a stored ISO snapshot date as a local `YYYY-MM-DD` for a date input. */
export const dateInputValue = (iso: string): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : getDateString(d);
};

/** A snapshot belongs on the page when its date falls inside the current view range. */
export const isInRange = (iso: string, start: Date, end: Date): boolean => {
  const d = new Date(iso);
  return d >= start && d <= end;
};

/**
 * The id `POST /api/snapshot` will derive for `targetDate`. The server builds it
 * as `${account_id}-${getSquashedDateString(new LocalDate(date))}`; `LocalDate`
 * reads a bare `YYYY-MM-DD` as local midnight and `getSquashedDateString` reads
 * local components back out, so the digits are exactly the input's, in any zone.
 */
export const snapshotIdFor = (accountId: string, targetDate: string): string =>
  `${accountId}-${targetDate.replace(/-/g, "")}`;

/**
 * Account snapshot ids are one-per-day (`${account_id}-${YYYYMMDD}`), so moving
 * a snapshot onto a day another snapshot already occupies would silently
 * overwrite it. Detect that before the write so the UI can block it.
 *
 * Compares ids rather than rendered dates. Rendering a stored timestamp through
 * `dateInputValue` is browser-local, but the id was squashed server-local — so a
 * row a PST server stored as `2026-07-10T07:00:00Z` reads as `2026-07-09` in a
 * UTC-10 browser, and the guard would miss the very collision it exists to catch.
 */
export const hasDateCollision = (
  snapshots: { id: string; date: string }[],
  accountId: string,
  targetDate: string,
  excludeId: string,
): boolean => {
  const targetId = snapshotIdFor(accountId, targetDate);
  return snapshots.some((s) => s.id !== excludeId && s.id === targetId);
};
