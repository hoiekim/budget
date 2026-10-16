import type { RecurringCadence } from "./models";
import { getDateString } from "./utils";

/**
 * One period of each cadence as calendar arithmetic. Deliberately not the
 * fractional day counts in `detect-recurrings.ts` — those are detection
 * tolerances, while a schedule has to land on the same day of the month.
 */
const CADENCE_STEPS: Record<RecurringCadence, { days: number } | { months: number }> = {
  weekly: { days: 7 },
  biweekly: { days: 14 },
  monthly: { months: 1 },
  quarterly: { months: 3 },
  semiannual: { months: 6 },
  annual: { months: 12 },
};

/**
 * `periods` cadence steps after `anchor`, in local time. Month steps are
 * always taken from the anchor and clamped to the target month's last
 * day, so a Jan 31 anchor yields Feb 28 → Mar 31 rather than drifting to
 * the 28th for good.
 */
const addCadence = (anchor: Date, cadence: RecurringCadence, periods: number): Date => {
  const step = CADENCE_STEPS[cadence];
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const day = anchor.getDate();
  if ("days" in step) return new Date(year, month, day + step.days * periods);
  const targetMonth = month + step.months * periods;
  const lastDayOfTarget = new Date(year, targetMonth + 1, 0).getDate();
  return new Date(year, targetMonth, Math.min(day, lastDayOfTarget));
};

/**
 * The next date a recurring is expected on: the first cadence step after
 * its latest occurrence that falls on or after `today`. Returns null for
 * an unparseable date.
 */
export const getNextRecurringDate = (
  latest: Date,
  cadence: RecurringCadence,
  today: Date = new Date(),
): Date | null => {
  if (Number.isNaN(latest.getTime()) || Number.isNaN(today.getTime())) return null;
  const todayString = getDateString(today);
  for (let periods = 1; ; periods++) {
    const next = addCadence(latest, cadence, periods);
    if (getDateString(next) >= todayString) return next;
  }
};
