import { Dispatch, SetStateAction, useCallback, useMemo } from "react";
import { getYearMonthString, Interval, parseYearMonthString, ViewDate } from "common";
import { ClientRouter } from "./router";

/**
 * Pure parser for the `view_date` URL param. Extracted so it can be
 * unit-tested without mounting the hook.
 *
 * URL format contract (matches what `setViewDate` writes):
 *
 * - month interval → `YYYY-MM` (7 chars, dashed — `getYearMonthString`
 *   output).
 * - year interval  → `YYYY`     (4 chars — bare year).
 *
 * Missing / invalid input falls back to today's month; keeps the hook
 * from ever throwing on a hand-edited URL.
 */
export const parseViewDateString = (
  viewDateString: string,
): { interval: Interval; date: Date } => {
  if (viewDateString.length === 4) {
    const year = parseInt(viewDateString);
    if (year) return { interval: "year", date: new Date(year, 0) };
  }
  const parsed = parseYearMonthString(viewDateString);
  return { interval: "month", date: parsed ?? new Date() };
};

export const useViewDate = (router: ClientRouter) => {
  const { path, params, go } = router;

  // URL is the source of truth. Read `params.get("view_date")` every
  // render so a back-button / cross-consumer navigation re-derives
  // viewDate without needing a separate state-sync effect. Memoize on
  // the raw string so the returned `ViewDate` reference stays stable
  // while the URL param doesn't change — consumers using viewDate in
  // their own `useMemo` deps don't thrash.
  const viewDateString = params.get("view_date") || getYearMonthString();

  const viewDate = useMemo(() => {
    const { interval, date } = parseViewDateString(viewDateString);
    return new ViewDate(interval, date);
  }, [viewDateString]);

  const setViewDate: Dispatch<SetStateAction<ViewDate>> = useCallback(
    (value) => {
      const resolvedValue = typeof value === "function" ? value(viewDate) : value;
      const newParams = new URLSearchParams(params);
      if (resolvedValue.getInterval() === "year") {
        newParams.set("view_date", resolvedValue.getEndDate().getFullYear().toString());
      } else {
        newParams.set("view_date", getYearMonthString(resolvedValue.getEndDate()));
      }
      go(path, { params: newParams, animate: false });
    },
    [viewDate, path, params, go],
  );

  // Explicit "Current mode" — remove the URL param entirely rather than
  // setting it to today's period. A bookmark to `/dashboard` with no
  // `view_date` param always shows the CURRENT period (whatever "now"
  // is when the bookmark opens), while `/dashboard?view_date=2026-07`
  // is frozen to that period even on a bookmark loaded in 2027.
  const resetViewDate = useCallback(() => {
    const newParams = new URLSearchParams(params);
    newParams.delete("view_date");
    // Explicit opt-out: `go()`'s default view_date preservation would
    // re-inject the current URL's `view_date` back into `newParams`
    // since it isn't set. This writer wants the param GONE.
    go(path, { params: newParams, animate: false, preserveViewDate: false });
  }, [path, params, go]);

  return [viewDate, setViewDate, resetViewDate] as const;
};
