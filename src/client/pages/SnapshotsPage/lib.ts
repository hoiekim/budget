import { getDateString } from "common";

/** Render a stored ISO snapshot date as a local `YYYY-MM-DD` for a date input. */
export const dateInputValue = (iso: string): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : getDateString(d);
};

/**
 * A snapshot belongs on the page when the day it occupies falls inside the
 * current view range.
 *
 * Takes a bare `YYYY-MM-DD` day rather than the stored instant, and compares it
 * against the range's local day bounds, so it agrees with the day the row shows
 * and edits against. Comparing the raw timestamp instead files a row by the
 * browser's reading of a server-local midnight, which can drop it into the
 * neighbouring month — a snapshot whose id says the 1st listed under the
 * previous month while displaying the 1st.
 */
export const isDayInRange = (day: string, start: Date, end: Date): boolean =>
  day >= getDateString(start) && day <= getDateString(end);

/**
 * The id `POST /api/snapshot` will derive for `targetDate`. The server builds it
 * as `${account_id}-${getSquashedDateString(new LocalDate(date))}`; `LocalDate`
 * reads a bare `YYYY-MM-DD` as local midnight and `getSquashedDateString` reads
 * local components back out, so the digits are exactly the input's, in any zone.
 */
export const snapshotIdFor = (accountId: string, targetDate: string): string =>
  `${accountId}-${targetDate.replace(/-/g, "")}`;

/**
 * The inverse: the calendar day an account snapshot's id encodes.
 *
 * This — not the stored timestamp — is what the row must show and edit against.
 * The id is the snapshot's identity (one per account per day) and both writers
 * derive it the same way, from the SERVER's local components: `post-snapshot.ts`
 * for user edits and `create-snapshots.ts` for the sync. Rendering the
 * timestamp instead reads it in the BROWSER's zone, so a row can display, and
 * compare against, a different day than it actually occupies.
 *
 * Returns null when the id is not the expected `<account_id>-<YYYYMMDD>` shape,
 * so the caller can fall back rather than render garbage.
 */
export const dateFromSnapshotId = (id: string): string | null => {
  const match = /-(\d{4})(\d{2})(\d{2})$/.exec(id);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
};

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
  snapshotIds: string[],
  accountId: string,
  targetDate: string,
  excludeId: string,
): boolean => {
  const targetId = snapshotIdFor(accountId, targetDate);
  return snapshotIds.some((id) => id !== excludeId && id === targetId);
};

/**
 * The message to show for a failed call.
 *
 * `call` returns `status: "error"` with the raw transport text for a fetch or
 * parse failure ("Failed to fetch", "Load failed" — the wording is the
 * browser's, not ours), so only a `status: "failed"` message is a domain
 * message worth putting in front of the user. The 401 gate
 * (`start.ts` → "Not authenticated.") is `failed`; `Route`'s catch-all
 * ("Internal server error") is `error`.
 */
export const failureMessage = (
  r: { status: string; message?: string } | void,
  fallback: string,
): string => (r && r.status === "failed" && r.message ? r.message : fallback);

/**
 * Drop `ids` from a per-row state map.
 *
 * `keepIfChanged` is the value the in-flight write was built from: an entry that
 * is no longer reference-equal to it has been touched since the request went
 * out, so it is preserved rather than reverted out from under the user. Pass it
 * ONLY when the row's key is unchanged — if the row moved to a new id, a
 * preserved entry would sit under a key nothing renders, which is the stranded
 * state this clearing exists to prevent.
 */
export const dropRowState = <T,>(
  prev: Record<string, T>,
  ids: string[],
  keepIfChanged?: T,
): Record<string, T> => {
  const next = { ...prev };
  ids.forEach((id) => {
    if (keepIfChanged && prev[id] && prev[id] !== keepIfChanged) return;
    delete next[id];
  });
  return next;
};
