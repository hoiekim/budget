//! Fills a monthly price snapshot for each month a security has been held:
//! `src/server/lib/compute-tools/backfill-snapshots.ts`.

use std::collections::{HashMap, HashSet};

use serde_json::json;

use crate::common::date::{get_date_string, get_squashed_date_string, get_year_month_string};
use crate::js::{self, JsDate, Json, Obj};
use crate::server::logger;
use crate::server::market_data::get_close_price_with_fallback;
use crate::server::polygon::{LookupOptions, PolygonErrorKind};
use crate::server::postgres::repositories::securities::search_securities_by_id;
use crate::server::postgres::repositories::snapshots::{get_security_snapshots, upsert_snapshots, SecuritySnapshotsOptions};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BackfillSecurityRef {
    pub security_id: String,
    /// ISO date the security was first observed in a holding snapshot for this caller.
    pub from_date: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BackfillResult {
    /// Number of months newly filled with a security snapshot.
    pub filled: i64,
    /// Number of months skipped because a snapshot already existed.
    pub skipped: i64,
    /// Number of price lookups that returned no data (delisted, holiday, etc.).
    pub empty: i64,
    /// Number of price lookup errors encountered.
    pub errors: i64,
}

impl BackfillResult {
    pub fn to_obj(&self) -> Obj {
        crate::ctx! { "filled": self.filled, "skipped": self.skipped, "empty": self.empty, "errors": self.errors }
    }
}

/// The options of `backfill_monthly_security_snapshots_forward`. `Default::default()` is the TypeScript's `{}`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BackfillOptions {
    /// At most this many months per security; 60 when `None`.
    pub max_months_per_invocation: Option<i64>,
}

const MAX_MONTHS_PER_INVOCATION: i64 = 60;

/// Ensure each (security, month) tuple between `from_date` and today has a
/// security snapshot, filling missing months from the close on the 15th of
/// that month (the current month takes yesterday's close).
///
/// Forward-only by design: it never reaches into months before the caller's
/// `from_date`, even if the security has been around longer in the user's
/// portfolio. The 60-month per-invocation cap is a sanity ceiling for
/// accidental "5-year-old manual holding" inputs.
///
/// Polygon calls are gated by the per-minute queue in `polygon.rs`. A
/// backfill that needs 30 calls on a free-tier key takes about 6 minutes;
/// that is intentional, as bursts would be refused.
///
/// Cash-equivalents (`type = 'cash'`, tickers like `CUR:USD`) are skipped:
/// Polygon does not price them.
///
/// `Err` where the Yahoo fallback fails in a way the TypeScript throws from.
pub async fn backfill_monthly_security_snapshots_forward(
    refs: &[BackfillSecurityRef],
    options: BackfillOptions,
) -> anyhow::Result<BackfillResult> {
    let cap = options.max_months_per_invocation.unwrap_or(MAX_MONTHS_PER_INVOCATION);

    let mut result = BackfillResult::default();

    if refs.is_empty() {
        return Ok(result);
    }

    // Batch-resolve ticker and type from the securities table so callers only
    // need to pass security ids.
    let ids: Vec<String> = refs.iter().map(|r| r.security_id.clone()).collect();
    let securities = search_securities_by_id(&ids).await?;
    let mut security_meta: HashMap<String, (Json, Json)> = HashMap::new();
    for security in &securities {
        let Some(security_id) = security.get("security_id").and_then(Json::as_str) else { continue };
        let field = |key: &str| security.get(key).cloned().unwrap_or(Json::Null);
        security_meta.insert(security_id.to_string(), (field("ticker_symbol"), field("type")));
    }

    let now_year_month = get_year_month_string(JsDate::now());

    for r in refs {
        let (security_id, from_date) = (&r.security_id, &r.from_date);
        if security_id.is_empty() || from_date.is_empty() {
            continue;
        }

        let Some((ticker, security_type)) = security_meta.get(security_id) else {
            logger::warn("backfill: no security row for ref", Some(&crate::ctx! { "security_id": security_id }), None);
            continue;
        };
        if !js::truthy(ticker) {
            // No ticker: nothing to fetch.
            continue;
        }
        let ticker_symbol = js::to_js_string(ticker);
        if security_type.as_str() == Some("cash") || ticker_symbol.starts_with("CUR:") {
            // Cash-equivalent: Polygon does not price these.
            continue;
        }

        // An unparseable date gives `NaN-NaN`, which sorts after every month.
        let from_year_month = get_year_month_string(JsDate::parse(from_date));
        if from_year_month > now_year_month {
            continue;
        }

        // Existing snapshots for this security, keyed by year and month.
        let existing =
            match get_security_snapshots(SecuritySnapshotsOptions { security_id: Some(security_id.clone()), ..Default::default() }).await {
                Ok(existing) => existing,
                Err(error) => {
                    logger::error(
                        "backfill: failed to load existing security snapshots",
                        Some(&crate::ctx! { "security_id": security_id }),
                        Some(&error),
                    );
                    result.errors += 1;
                    continue;
                }
            };
        let have_month: HashSet<String> = existing
            .iter()
            .map(|s| get_year_month_string(s.get("snapshot_date").map(JsDate::from_json).unwrap_or(JsDate::INVALID)))
            .collect();

        let mut new_snapshots: Vec<Obj> = Vec::new();
        let options = LookupOptions { security_type: security_type.as_str().map(str::to_string), ..Default::default() };

        let mut cursor = from_year_month;
        let mut months_touched = 0;
        while cursor <= now_year_month && months_touched < cap {
            let month = cursor.clone();
            cursor = next_year_month(&month);
            months_touched += 1;

            if have_month.contains(&month) {
                result.skipped += 1;
                continue;
            }

            // Snapshot date is the 15th for past months and the previous day
            // for the current month. Today's market hasn't closed yet, so the
            // snapshot is anchored to "yesterday's close" rather than labelling
            // an in-progress price with today's date.
            let day_in_month = if month == now_year_month { get_date_string(get_yesterday()) } else { format!("{month}-15") };
            let day = JsDate::parse(&day_in_month);
            let fetched = get_close_price_with_fallback(&ticker_symbol, day, &options).await?;

            let close_price = match fetched {
                Ok(close_price) => close_price,
                Err(failure) => {
                    if failure.error == PolygonErrorKind::NoData {
                        result.empty += 1;
                    } else {
                        result.errors += 1;
                    }
                    // Different months may have different outcomes (a delisted
                    // period, then an active one), so the loop carries on.
                    continue;
                }
            };

            let date = day.to_iso_string().ok_or_else(|| anyhow::anyhow!("Invalid Date"))?;
            let new_snapshot = json!({
                "snapshot": {
                    "snapshot_id": format!("{security_id}-{}", get_squashed_date_string(day)),
                    "date": date,
                },
                "security": {
                    "security_id": security_id,
                    "ticker_symbol": ticker_symbol,
                    "close_price": js::num(close_price),
                    "close_price_as_of": day_in_month,
                    // The rest of the security is unknown at backfill time;
                    // the securities row is left untouched and only the
                    // snapshot is written.
                    "name": null,
                    "iso_currency_code": null,
                    "isin": null,
                    "cusip": null,
                    "sedol": null,
                    "institution_security_id": null,
                    "institution_id": null,
                    "proxy_security_id": null,
                    "is_cash_equivalent": null,
                    "type": null,
                    "update_datetime": null,
                    "unofficial_currency_code": null,
                    "market_identifier_code": null,
                    "sector": null,
                    "industry": null,
                    "option_contract": null,
                    "fixed_income": null,
                },
            });
            if let Json::Object(new_snapshot) = new_snapshot {
                new_snapshots.push(new_snapshot);
            }
            result.filled += 1;
        }

        if !new_snapshots.is_empty() {
            // A failed write is logged per snapshot by `upsert_snapshots`.
            upsert_snapshots(&new_snapshots).await;
        }
    }

    Ok(result)
}

fn get_yesterday() -> JsDate {
    let d = JsDate::now();
    d.set_date(d.get_date() - 1)
}

/// Advance a `YYYY-MM` string by one month.
fn next_year_month(ym: &str) -> String {
    let mut parts = ym.split('-');
    let y = js::to_number(parts.next().unwrap_or(""));
    let m = parts.next().map(js::to_number).unwrap_or(f64::NAN);
    if !y.is_finite() || !m.is_finite() {
        return ym.to_string();
    }
    let next_month = if m == 12.0 { 1.0 } else { m + 1.0 };
    let next_year = if m == 12.0 { y + 1.0 } else { y };
    format!("{}-{:0>2}", js::number_to_string(next_year), js::number_to_string(next_month))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_year_month_rolls_over_the_year() {
        assert_eq!(next_year_month("2026-01"), "2026-02");
        assert_eq!(next_year_month("2026-09"), "2026-10");
        assert_eq!(next_year_month("2026-12"), "2027-01");
        assert_eq!(next_year_month("NaN-NaN"), "NaN-NaN");
    }

    #[tokio::test]
    async fn returns_zero_counts_on_empty_refs() {
        let result = backfill_monthly_security_snapshots_forward(&[], BackfillOptions::default()).await.unwrap();
        assert_eq!(result, BackfillResult { filled: 0, skipped: 0, empty: 0, errors: 0 });
    }

    #[test]
    fn an_unparseable_from_date_sorts_after_every_month() {
        assert!(get_year_month_string(JsDate::parse("yesterday")) > get_year_month_string(JsDate::now()));
    }
}
