//! Keeps a current price snapshot for every held security and the benchmark:
//! `src/server/lib/compute-tools/refresh-security-snapshots.ts`.

use std::collections::HashSet;

use serde_json::json;

use crate::common::constants::{BENCHMARK_HISTORY_THROUGH, BENCHMARK_TICKER};
use crate::common::date::{get_date_string, get_squashed_date_string};
use crate::js::{truthy, Json, JsDate, Obj};
use crate::server::logger;
use crate::server::market_data::get_latest_close_price_on_or_before_with_fallback;
use crate::server::polygon::{self, Close, LookupOptions, PolygonErrorKind, PolygonResult};
use crate::server::postgres::client::{pool, Executor};
use crate::server::postgres::repositories::securities::{search_securities, search_securities_by_id, upsert_securities, SearchSecuritiesOptions};
use crate::server::postgres::repositories::snapshots::upsert_snapshots;

/// What one run did, in the order the scheduler logs it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RefreshSecuritySnapshotsResult {
    /// Securities for which a fresh snapshot was written this run.
    pub refreshed: i64,
    /// Securities skipped because a non-stale snapshot already exists.
    pub fresh: i64,
    /// Securities skipped because they are cash-equivalents.
    pub cash: i64,
    /// Polygon returned `no_data` (untracked / delisted / out-of-plan window).
    pub empty: i64,
    /// Polygon API or upsert errors.
    pub errors: i64,
}

impl RefreshSecuritySnapshotsResult {
    pub fn to_obj(&self) -> Obj {
        crate::ctx! {
            "refreshed": self.refreshed,
            "fresh": self.fresh,
            "cash": self.cash,
            "empty": self.empty,
            "errors": self.errors,
        }
    }
}

/// Skip-window for the per-security cadence gate: if any security snapshot
/// of a security was written or updated within it, the price refresh is
/// skipped this cycle. Wider than the hourly cadence so most cycles skip
/// without spending a call, narrow enough that a missed update only delays a
/// fresh price by about a day.
const REFRESH_SKIP_WINDOW_HOURS: i64 = 22;

/// The id of the benchmark's security row when no provider has written one.
pub fn benchmark_security_id() -> String {
    format!("benchmark-{BENCHMARK_TICKER}")
}

fn text<'a>(security: &'a Json, key: &str) -> Option<&'a str> {
    security.get(key).and_then(|value| value.as_str())
}

fn is_cash(security: &Json) -> bool {
    text(security, "type") == Some("cash") || text(security, "ticker_symbol").map(|t| t.starts_with("CUR:")).unwrap_or(false)
}

/// The benchmark's security row: the latest one with its ticker, or one
/// written for it when there is none, so its prices sync to every user
/// whether or not anyone holds it.
async fn get_benchmark_security_id() -> anyhow::Result<Option<String>> {
    let existing = search_securities(SearchSecuritiesOptions { ticker_symbol: Some(BENCHMARK_TICKER.to_string()), ..Default::default() }).await?;
    if let Some(security) = existing.iter().find(|security| !is_cash(security)) {
        return Ok(text(security, "security_id").map(str::to_string));
    }
    let security = json!({
        "security_id": benchmark_security_id(),
        "ticker_symbol": BENCHMARK_TICKER,
        "name": "Vanguard S&P 500 ETF",
        "iso_currency_code": "USD",
        "type": "etf",
        "close_price": null,
        "close_price_as_of": null,
        "isin": null,
        "cusip": null,
        "sedol": null,
        "institution_security_id": null,
        "institution_id": null,
        "proxy_security_id": null,
        "is_cash_equivalent": null,
        "update_datetime": null,
        "unofficial_currency_code": null,
        "market_identifier_code": null,
        "sector": null,
        "industry": null,
        "option_contract": null,
        "fixed_income": null,
    });
    let written = upsert_securities(&[security.as_object().cloned().unwrap_or_default()]).await;
    Ok(match written.first() {
        Some(result) if result.status < 400 => Some(benchmark_security_id()),
        _ => None,
    })
}

/// Noon UTC of a trading day, the instant its snapshot is dated by.
fn noon_utc(trading_date: &str) -> JsDate {
    JsDate::parse(&format!("{trading_date}T12:00:00Z"))
}

fn iso(date: JsDate) -> anyhow::Result<String> {
    date.to_iso_string().ok_or_else(|| anyhow::anyhow!("Invalid Date"))
}

fn security_snapshot_of(security: &Json, close: &Close) -> anyhow::Result<Obj> {
    let trading_date = noon_utc(&close.trading_date);
    let snapshot = json!({
        "snapshot": {
            "snapshot_id": format!("{}-{}", text(security, "security_id").unwrap_or(""), get_squashed_date_string(trading_date)),
            "date": iso(trading_date)?,
        },
        "security": {
            "security_id": security.get("security_id").cloned().unwrap_or(Json::Null),
            "ticker_symbol": security.get("ticker_symbol").cloned().unwrap_or(Json::Null),
            "close_price": crate::js::num(close.price),
            "close_price_as_of": get_date_string(trading_date),
            // The rest is left null: the snapshot row only carries
            // security_id and close_price; the securities row is untouched.
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
    Ok(snapshot.as_object().cloned().unwrap_or_default())
}

fn shift_day(date: &str, days: i64) -> anyhow::Result<String> {
    let shifted = noon_utc(date).plus_ms(days as f64 * 86_400_000.0);
    Ok(iso(shifted)?.chars().take(10).collect())
}

/// The date of a security's latest live price snapshot, `YYYY-MM-DD`.
async fn get_latest_snapshot_date(security_id: &str) -> anyhow::Result<Option<String>> {
    let latest = pool()
        .query(
            "SELECT to_char(MAX(snapshot_date) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date
     FROM snapshots
     WHERE security_id = $1
       AND snapshot_type = 'security'
       AND (is_deleted IS NULL OR is_deleted = FALSE)",
            &[json!(security_id)],
        )
        .await?;
    Ok(latest.rows.first().and_then(|row| row.get("date")).and_then(|date| date.as_str()).map(str::to_string))
}

/// The closes to write for a security: the latest trading day's. The
/// benchmark also gets every settled trading day since its last snapshot, or
/// since the static history's last row when it has none, from one range
/// request ending yesterday. When there is nothing to fill, the range is
/// empty, or Polygon refuses it for the plan, only the latest close is
/// written. A failure that may pass writes nothing, so the next pass asks for
/// the whole range again.
async fn get_closes_to_write(security: &Json, benchmark: Option<&str>, today: JsDate) -> anyhow::Result<PolygonResult<Vec<Close>>> {
    let ticker = text(security, "ticker_symbol").unwrap_or("");
    let options = LookupOptions { security_type: text(security, "type").map(str::to_string), ..Default::default() };
    let latest = || async {
        let fetched = get_latest_close_price_on_or_before_with_fallback(ticker, today, &options).await?;
        anyhow::Ok(fetched.map(|close| vec![close]))
    };
    let security_id = text(security, "security_id");
    if security_id != benchmark || security_id.is_none() {
        return latest().await;
    }
    let since = get_latest_snapshot_date(security_id.unwrap_or("")).await?.unwrap_or_else(|| BENCHMARK_HISTORY_THROUGH.to_string());
    let from = shift_day(&since, 1)?;
    let to = shift_day(&get_date_string(today), -1)?;
    if from > to {
        return latest().await;
    }
    let range = polygon::get_daily_closes(ticker, &from, &to, &options).await;
    let settled = match &range {
        Ok(_) => true,
        Err(failure) => matches!(failure.error, PolygonErrorKind::NoData | PolygonErrorKind::PlanLimit),
    };
    if range.is_ok() || !settled {
        return Ok(range);
    }
    latest().await
}

/// For every security a live holding references, and for the benchmark,
/// makes sure a security snapshot exists for the latest trading day the
/// market data can serve. Rides the hourly scheduled sync.
///
/// One batched pre-flight read of `snapshots.updated` gates the whole pass:
/// a security whose snapshot was touched within `REFRESH_SKIP_WINDOW_HOURS`
/// is skipped, so a steady-state run costs one query and no price call.
/// Cash-equivalents (`type = 'cash'` or a `CUR:` ticker) are skipped.
pub async fn refresh_active_security_snapshots_at(now: JsDate) -> anyhow::Result<RefreshSecuritySnapshotsResult> {
    let mut result = RefreshSecuritySnapshotsResult::default();

    let rows = pool()
        .query(
            "SELECT DISTINCT security_id
     FROM holdings
     WHERE (is_deleted IS NULL OR is_deleted = FALSE)
       AND security_id IS NOT NULL",
            &[],
        )
        .await?;
    let benchmark = get_benchmark_security_id().await?;
    let mut seen = HashSet::new();
    let security_ids: Vec<String> = rows
        .rows
        .iter()
        .map(|row| row.get("security_id").cloned().unwrap_or(Json::Null))
        .chain(std::iter::once(benchmark.clone().map(Json::String).unwrap_or(Json::Null)))
        .filter(truthy)
        .filter_map(|id| id.as_str().map(str::to_string))
        .filter(|id| seen.insert(id.clone()))
        .collect();
    if security_ids.is_empty() {
        return Ok(result);
    }

    let securities = search_securities_by_id(&security_ids).await?;
    let today = now;

    // One batched cadence gate for the pass, over exactly the securities the
    // loop would gate: cash and tickerless rows are skipped before it.
    let gate_ids: Vec<Json> = securities
        .iter()
        .filter(|s| text(s, "ticker_symbol").map(|t| !t.is_empty()).unwrap_or(false) && !is_cash(s))
        .map(|s| s.get("security_id").cloned().unwrap_or(Json::Null))
        .collect();
    let mut fresh: HashSet<String> = HashSet::new();
    if !gate_ids.is_empty() {
        let sql = format!(
            "SELECT DISTINCT security_id FROM snapshots
       WHERE security_id = ANY($1::text[])
         AND snapshot_type = 'security'
         AND updated > NOW() - INTERVAL '{REFRESH_SKIP_WINDOW_HOURS} hours'"
        );
        let recent = pool().query(&sql, &[Json::Array(gate_ids)]).await?;
        for row in &recent.rows {
            if let Some(id) = row.get("security_id").and_then(|id| id.as_str()) {
                fresh.insert(id.to_string());
            }
        }
    }

    for security in &securities {
        let security_id = text(security, "security_id").unwrap_or("").to_string();
        if !text(security, "ticker_symbol").map(|t| !t.is_empty()).unwrap_or(false) {
            continue;
        }
        if is_cash(security) {
            result.cash += 1;
            continue;
        }
        // A snapshot touched within the window, or soft-deleted within it
        // (which stamps `updated`), skips the price call.
        if fresh.contains(&security_id) {
            result.fresh += 1;
            continue;
        }

        let closes = match get_closes_to_write(security, benchmark.as_deref(), today).await? {
            Ok(closes) => closes,
            Err(failure) => {
                if failure.error == PolygonErrorKind::NoData {
                    result.empty += 1;
                } else {
                    result.errors += 1;
                }
                continue;
            }
        };

        // `upsert_snapshots` reports each row's status instead of failing;
        // a 4xx / 5xx status means the row didn't land.
        let snapshots: Vec<Obj> = closes.iter().map(|close| security_snapshot_of(security, close)).collect::<anyhow::Result<_>>()?;
        let upserted = upsert_snapshots(&snapshots).await;
        let failed: Vec<u16> = upserted.iter().filter(|r| r.status >= 400).map(|r| r.status).collect();
        if !failed.is_empty() || upserted.is_empty() {
            logger::error(
                "refreshActiveSecuritySnapshots: upsert failed",
                Some(&crate::ctx! {
                    "security_id": security_id,
                    "tradingDates": closes.iter().map(|c| c.trading_date.clone()).collect::<Vec<_>>(),
                    "statuses": failed,
                }),
                None,
            );
            result.errors += 1;
        } else {
            result.refreshed += 1;
        }
    }

    Ok(result)
}

/// The scheduler's entry point: a run as of now, as the counts it logs.
pub async fn refresh_active_security_snapshots() -> anyhow::Result<Obj> {
    Ok(refresh_active_security_snapshots_at(JsDate::now()).await?.to_obj())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cash_is_a_cash_type_or_a_currency_ticker() {
        assert!(is_cash(&json!({ "type": "cash", "ticker_symbol": "X" })));
        assert!(is_cash(&json!({ "type": "equity", "ticker_symbol": "CUR:USD" })));
        assert!(!is_cash(&json!({ "type": "etf", "ticker_symbol": "VOO" })));
        assert!(!is_cash(&json!({ "type": null, "ticker_symbol": null })));
    }

    #[test]
    fn days_shift_across_month_and_year_ends() {
        assert_eq!(shift_day("2026-10-13", 1).unwrap(), "2026-10-14");
        assert_eq!(shift_day("2026-12-31", 1).unwrap(), "2027-01-01");
        assert_eq!(shift_day("2026-03-01", -1).unwrap(), "2026-02-28");
        assert!(shift_day("not a date", 1).is_err());
    }
}
