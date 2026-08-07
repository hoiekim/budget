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
 * Account snapshot ids are one-per-day (`${account_id}-${YYYYMMDD}`), so moving
 * a snapshot onto a day another snapshot already occupies would silently
 * overwrite it. Detect that before the write so the UI can block it.
 */
export const hasDateCollision = (
  snapshots: { id: string; date: string }[],
  targetDate: string,
  excludeId: string,
): boolean =>
  snapshots.some((s) => s.id !== excludeId && dateInputValue(s.date) === targetDate);
