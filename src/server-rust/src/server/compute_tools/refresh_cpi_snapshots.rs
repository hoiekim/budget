//! Keeps the stored CPI-U series current and backfilled:
//! `src/server/lib/compute-tools/refresh-cpi-snapshots.ts`.

use std::collections::BTreeSet;

use serde_json::json;

use crate::js::{to_number, Json, JsDate, Obj};
use crate::server::bls::{self, BlsErrorKind};
use crate::server::inflation::{to_month_index, INFLATION_AVERAGE_YEARS};
use crate::server::logger;
use crate::server::postgres::repositories::cpi_snapshots::{get_cpi_snapshots, upsert_cpi_snapshots};

/// What one run did, in the order the scheduler logs it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RefreshCpiSnapshotsResult {
    /// BLS requests sent this run.
    pub requests: i64,
    /// CPI months written or re-stamped.
    pub upserted: i64,
    /// The stored series already reaches the newest month BLS could have published.
    pub fresh: bool,
    /// The series is behind, but a refresh ran within the skip window, so this run waits.
    pub gated: bool,
    /// Planned requests left for a later run: the daily budget (ours or BLS's) is spent, or BLS failed.
    pub deferred: i64,
    /// BLS errors, empty answers, and failed writes.
    pub errors: i64,
}

impl RefreshCpiSnapshotsResult {
    pub fn to_obj(&self) -> Obj {
        crate::ctx! {
            "requests": self.requests,
            "upserted": self.upserted,
            "fresh": self.fresh,
            "gated": self.gated,
            "deferred": self.deferred,
            "errors": self.errors,
        }
    }
}

/// Minimum spacing between refreshes of the newest months. CPI is monthly and
/// lands around mid-month, so while the next release is pending this keeps the
/// steady state to about one request a day — the same 22-hour window the
/// security-snapshot refresh uses, wide enough that most hourly runs make no
/// call at all.
pub const CPI_REFRESH_SKIP_WINDOW_HOURS: f64 = 22.0;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CpiFetchPlan {
    /// Inclusive `[start_year, end_year]` spans, one BLS request each.
    pub requests: Vec<(i64, i64)>,
    pub fresh: bool,
    pub gated: bool,
}

fn text_of<'a>(snapshot: &'a Json, key: &str) -> &'a str {
    snapshot.get(key).and_then(|value| value.as_str()).unwrap_or("")
}

/// Decides which years to request, without touching the network.
///
/// Backfill: every completed year inside the averaging window (plus one, so
/// the window's first month has a base to compare against) with no stored
/// month at all. Years are tested for presence, not completeness: BLS has
/// gaps it will never fill (October 2025), and re-requesting those would
/// spend the budget forever.
///
/// Refresh: the newest month BLS can have published is last month. When the
/// stored series stops short of it and nothing was written in the skip
/// window, re-request from the latest stored year through this year.
///
/// Contiguous years are merged and then split at the tier's per-request cap.
pub fn plan_cpi_fetch(snapshots: &[Json], now: JsDate, max_years_per_request: i64) -> CpiFetchPlan {
    let current_year = now.get_full_year();
    let first_year = current_year - INFLATION_AVERAGE_YEARS - 1;
    let mut years: BTreeSet<i64> = BTreeSet::new();

    // `Number(date.slice(0, 4))`: a year that is not a number matches no year.
    let stored_years: Vec<f64> =
        snapshots.iter().map(|s| to_number(&text_of(s, "date").chars().take(4).collect::<String>())).collect();
    for year in first_year..current_year {
        if !stored_years.contains(&(year as f64)) {
            years.insert(year);
        }
    }

    // The first index is taken as is, NaN included, as `latestStored === undefined || index > latestStored` does.
    let mut latest_stored: Option<f64> = None;
    let mut last_write = 0.0;
    for snapshot in snapshots {
        let index = to_month_index(text_of(snapshot, "date"));
        if latest_stored.map(|latest| index > latest).unwrap_or(true) {
            latest_stored = Some(index);
        }
        let updated = match snapshot.get("updated").and_then(|v| v.as_str()) {
            Some(text) if !text.is_empty() => JsDate::parse(text).get_time(),
            _ => f64::NAN,
        };
        if updated.is_finite() && updated > last_write {
            last_write = updated;
        }
    }

    let newest_publishable = (current_year * 12 + now.get_month() - 1) as f64;
    let fresh = latest_stored.map(|latest| latest >= newest_publishable).unwrap_or(false);
    let window_ms = CPI_REFRESH_SKIP_WINDOW_HOURS * 60.0 * 60.0 * 1000.0;
    let gated = !fresh && last_write > 0.0 && now.get_time() - last_write < window_ms;

    if !fresh && !gated {
        let from = match latest_stored {
            None => current_year as f64,
            Some(latest) => (latest / 12.0).floor(),
        };
        // A NaN start (an unreadable stored date) adds no year, as the loop's NaN comparison does.
        if !from.is_nan() {
            let start = (from as i64).max(first_year);
            for year in start..=current_year {
                years.insert(year);
            }
        }
    }

    let mut requests: Vec<(i64, i64)> = Vec::new();
    for year in years {
        match requests.last_mut() {
            Some(last) if last.1 == year - 1 && year - last.0 < max_years_per_request => last.1 = year,
            _ => requests.push((year, year)),
        }
    }

    CpiFetchPlan { requests, fresh, gated }
}

/// Keeps the stored CPI-U series current and backfilled, riding the hourly
/// scheduled sync the way the security-snapshot refresh does. BLS is never
/// called on a client request: `GET /inflation` reads what this job stored. A
/// failed request ends the run, and every request draws on the per-process
/// daily budget in `bls.rs`.
pub async fn refresh_cpi_snapshots_at(now: JsDate) -> anyhow::Result<RefreshCpiSnapshotsResult> {
    let series_id = bls::CPI_SERIES_ID;
    let tier = bls::get_bls_tier();
    let snapshots = get_cpi_snapshots(series_id).await?;
    let plan = plan_cpi_fetch(&snapshots, now, tier.max_years_per_request);

    let mut result = RefreshCpiSnapshotsResult { fresh: plan.fresh, gated: plan.gated, ..Default::default() };
    let now_index = now.get_full_year() * 12 + now.get_month();
    let planned = plan.requests.len() as i64;

    for (i, (start_year, end_year)) in plan.requests.iter().copied().enumerate() {
        let i = i as i64;
        let observations = match bls::get_cpi_series(start_year, end_year, Some(series_id)).await {
            Ok(observations) => observations,
            Err(failure) => {
                if failure.error != BlsErrorKind::BudgetExhausted {
                    result.requests += 1;
                }
                if matches!(failure.error, BlsErrorKind::BudgetExhausted | BlsErrorKind::RateLimited) {
                    result.deferred += planned - i;
                    logger::warn(
                        "refreshCpiSnapshots: daily BLS budget reached, deferring",
                        Some(&crate::ctx! { "startYear": start_year, "endYear": end_year, "message": failure.message }),
                        None,
                    );
                    break;
                }
                result.errors += 1;
                logger::warn(
                    "refreshCpiSnapshots: BLS request failed",
                    Some(&crate::ctx! {
                        "startYear": start_year,
                        "endYear": end_year,
                        "error": failure.error.as_str(),
                        "message": failure.message,
                    }),
                    None,
                );
                // An empty span says nothing about the next one; an API error likely repeats.
                if failure.error == BlsErrorKind::NoData {
                    continue;
                }
                result.deferred += planned - i - 1;
                break;
            }
        };
        result.requests += 1;

        let rows: Vec<Obj> = observations
            .iter()
            .filter(|o| o.year >= start_year && o.year <= end_year)
            .filter(|o| o.year * 12 + o.month - 1 <= now_index)
            .map(|o| {
                let mut row = Obj::new();
                row.insert("series_id".into(), json!(series_id));
                row.insert("date".into(), json!(format!("{}-{:02}-01", o.year, o.month)));
                row.insert("value".into(), crate::js::num(o.value));
                row
            })
            .collect();

        match upsert_cpi_snapshots(&rows).await {
            Ok(count) => result.upserted += count as i64,
            Err(error) => {
                logger::error(
                    "refreshCpiSnapshots: upsert failed",
                    Some(&crate::ctx! { "startYear": start_year, "endYear": end_year }),
                    Some(&error),
                );
                result.errors += 1;
            }
        }
    }

    Ok(result)
}

/// The scheduler's entry point: a run as of now, as the counts it logs.
pub async fn refresh_cpi_snapshots() -> anyhow::Result<Obj> {
    Ok(refresh_cpi_snapshots_at(JsDate::now()).await?.to_obj())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(date: &str, updated: Option<&str>) -> Json {
        json!({ "series_id": "CUUR0000SA0", "date": date, "value": 300.0, "updated": updated })
    }

    fn at(year: i64, month: i64, day: i64) -> JsDate {
        JsDate::from_local(year, month - 1, day, 12, 0, 0, 0)
    }

    #[test]
    fn an_empty_table_backfills_the_whole_window_split_at_the_tier_cap() {
        let plan = plan_cpi_fetch(&[], at(2026, 11, 22), 10);
        assert_eq!(plan, CpiFetchPlan { requests: vec![(2010, 2019), (2020, 2026)], fresh: false, gated: false });
        let keyed = plan_cpi_fetch(&[], at(2026, 11, 22), 20);
        assert_eq!(keyed.requests, vec![(2010, 2026)]);
    }

    #[test]
    fn a_current_series_asks_only_for_missing_years() {
        let mut snapshots: Vec<Json> = (2010..=2026).map(|year| snapshot(&format!("{year}-01-01"), None)).collect();
        snapshots.push(snapshot("2026-10-01", None));
        let plan = plan_cpi_fetch(&snapshots, at(2026, 11, 22), 10);
        assert_eq!(plan, CpiFetchPlan { requests: vec![], fresh: true, gated: false });
        snapshots.retain(|s| text_of(s, "date") != "2015-01-01");
        assert_eq!(plan_cpi_fetch(&snapshots, at(2026, 11, 22), 10).requests, vec![(2015, 2015)]);
    }

    #[test]
    fn a_recent_write_gates_the_refresh_of_the_newest_months() {
        let now = at(2026, 11, 22);
        let recent = JsDate::from_ms(now.get_time() - 3_600_000.0).to_iso_string().unwrap();
        let old = JsDate::from_ms(now.get_time() - 23.0 * 3_600_000.0).to_iso_string().unwrap();
        let behind: Vec<Json> = (2010..=2026).map(|year| snapshot(&format!("{year}-01-01"), Some(&recent))).collect();
        assert_eq!(plan_cpi_fetch(&behind, now, 10), CpiFetchPlan { requests: vec![], fresh: false, gated: true });
        let stale: Vec<Json> = (2010..=2026).map(|year| snapshot(&format!("{year}-01-01"), Some(&old))).collect();
        assert_eq!(plan_cpi_fetch(&stale, now, 10), CpiFetchPlan { requests: vec![(2026, 2026)], fresh: false, gated: false });
    }
}
