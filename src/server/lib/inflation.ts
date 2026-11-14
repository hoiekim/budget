import { JSONAverageInflation, JSONCpiSnapshot } from "common";
import { getCpiSnapshots } from "server";
import { CPI_SERIES_ID } from "./bls";

/**
 * How far back the average reaches, and so how much history the scheduled
 * backfill keeps. Thirty years spans a typical retirement horizon and is long
 * enough that one hot or cold decade does not dominate the rate.
 */
export const INFLATION_AVERAGE_YEARS = 30;

/** Less than a year of history cannot produce a meaningful annual rate. */
const MIN_SPAN_MONTHS = 12;

/** Months since year 0 for a `YYYY-MM` or `YYYY-MM-DD` string. */
export const toMonthIndex = (date: string): number => {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return year * 12 + (month - 1);
};

/** Inverse of `toMonthIndex`, as `YYYY-MM`. */
export const fromMonthIndex = (index: number): string => {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
};

/**
 * Average annual inflation as the compound growth of the index between the
 * latest stored month and the month `years` earlier:
 *
 *   (CPI_latest / CPI_base) ^ (12 / months_between)
 *
 * The compound rate is what the projection needs — it multiplies living cost
 * by `year_over_year_inflation` every year, so an arithmetic mean of yearly
 * rates would overstate the long-run drift. Comparing the same calendar month
 * also cancels the seasonality of the non-seasonally-adjusted series.
 *
 * The base is the earliest stored month inside the window, so a missing month
 * (BLS publishes none for October 2025) or a backfill that has not reached
 * the full window yet shortens the span instead of failing; the exponent uses
 * the real span either way.
 */
export const computeAverageInflation = (
  snapshots: JSONCpiSnapshot[],
  years: number = INFLATION_AVERAGE_YEARS,
): JSONAverageInflation | null => {
  const points = snapshots
    .filter((s) => Number.isFinite(s.value) && s.value > 0 && /^\d{4}-\d{2}/.test(s.date))
    .map((s) => ({ index: toMonthIndex(s.date), value: s.value, series_id: s.series_id }))
    .sort((a, b) => a.index - b.index);
  if (points.length < 2) return null;

  const latest = points[points.length - 1];
  const windowStart = latest.index - years * 12;
  const base = points.find((p) => p.index >= windowStart && p.series_id === latest.series_id);
  if (!base) return null;

  const span = latest.index - base.index;
  if (span < MIN_SPAN_MONTHS) return null;

  return {
    year_over_year_inflation: Math.pow(latest.value / base.value, 12 / span),
    from: fromMonthIndex(base.index),
    to: fromMonthIndex(latest.index),
    series_id: latest.series_id,
  };
};

/** Average inflation from the stored CPI series. Database only — never calls BLS. */
export const getAverageInflation = async (): Promise<JSONAverageInflation | null> => {
  const snapshots = await getCpiSnapshots(CPI_SERIES_ID);
  return computeAverageInflation(snapshots);
};
