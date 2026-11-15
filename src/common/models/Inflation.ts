/**
 * One month of a Consumer Price Index series as stored in `cpi_snapshots`.
 * Written only by the scheduled BLS refresh (`refreshCpiSnapshots`); the
 * request path reads these rows and never calls BLS itself.
 */
export interface JSONCpiSnapshot {
  /** BLS series id, e.g. `CUUR0000SA0` (CPI-U, U.S. city average, all items). */
  series_id: string;
  /** First day of the observed month, `YYYY-MM-DD`. */
  date: string;
  /** Index level for that month (1982-84 = 100 for CPI-U). */
  value: number;
  /** When the row was last written; drives the refresh cadence gate. */
  updated?: string | null;
}

/**
 * Annualized inflation averaged over the stored CPI history, served by
 * `GET /api/inflation` for the projection chart's auto goal configuration.
 */
export interface JSONAverageInflation {
  /**
   * Year-over-year multiplier — `1.025` means 2.5% a year. Same encoding as
   * `ProjectionChartConfiguration.year_over_year_inflation`, so the client
   * can drop it in without converting.
   */
  year_over_year_inflation: number;
  /** First month (`YYYY-MM`) the average spans. */
  from: string;
  /** Last month (`YYYY-MM`) the average spans — the latest stored observation. */
  to: string;
  series_id: string;
}
