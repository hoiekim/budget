//! Average annual inflation from the stored CPI series: `src/server/lib/inflation.ts`.

use std::cmp::Ordering;

use serde_json::json;

use crate::js::{num, number_to_string, to_number, Json, Obj};
use crate::server::bls::CPI_SERIES_ID;
use crate::server::postgres::repositories::cpi_snapshots::get_cpi_snapshots;

/// How far back the average reaches, and so how much history the scheduled
/// backfill keeps.
pub const INFLATION_AVERAGE_YEARS: i64 = 15;

/// Less than a year of history cannot produce a meaningful annual rate.
const MIN_SPAN_MONTHS: f64 = 12.0;

/// `text.slice(start, end)`, counted in UTF-16 code units as JS counts them.
fn js_slice(text: &str, start: usize, end: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().skip(start).take(end.saturating_sub(start)).collect();
    String::from_utf16_lossy(&units)
}

/// Months since year 0 for a `YYYY-MM` or `YYYY-MM-DD` string. NaN for text
/// that holds no year or month there, as `Number()` gives.
pub fn to_month_index(date: &str) -> f64 {
    let year = to_number(&js_slice(date, 0, 4));
    let month = to_number(&js_slice(date, 5, 7));
    year * 12.0 + (month - 1.0)
}

/// Inverse of `to_month_index`, as `YYYY-MM`.
pub fn from_month_index(index: f64) -> String {
    let year = (index / 12.0).floor();
    let month = number_to_string(index % 12.0 + 1.0);
    format!("{}-{}{}", number_to_string(year), if month.len() < 2 { "0" } else { "" }, month)
}

/// `/^\d{4}-\d{2}/.test(date)`.
fn starts_with_year_and_month(date: &str) -> bool {
    let bytes = date.as_bytes();
    bytes.len() >= 7 && bytes[..4].iter().all(u8::is_ascii_digit) && bytes[4] == b'-' && bytes[5..7].iter().all(u8::is_ascii_digit)
}

struct Point<'a> {
    index: f64,
    value: f64,
    series_id: Option<&'a Json>,
}

/// Average annual inflation as the compound growth of the index between the
/// latest stored month and the month `years` earlier:
///
///   (CPI_latest / CPI_base) ^ (12 / months_between)
///
/// The compound rate is what the projection needs: it multiplies living cost
/// by `year_over_year_inflation` every year, so an arithmetic mean of yearly
/// rates would overstate the long-run drift. Comparing the same calendar month
/// also cancels the seasonality of the non-seasonally-adjusted series.
///
/// The base is the earliest stored month inside the window, so a missing month
/// (BLS publishes none for October 2025) or a backfill that has not reached
/// the full window yet shortens the span instead of failing; the exponent uses
/// the real span either way.
///
/// `snapshots` are `JSONCpiSnapshot`s as `get_cpi_snapshots` returns them; the
/// result is a `JSONAverageInflation`, or `None` where the TypeScript returns `null`.
pub fn compute_average_inflation(snapshots: &[Json], years: i64) -> Option<Json> {
    let mut points: Vec<Point> = snapshots
        .iter()
        .filter_map(|snapshot| {
            // `Number.isFinite` holds for nothing but a number, and only a string
            // read from a DATE column can match the pattern.
            let value = snapshot.get("value").and_then(Json::as_f64)?;
            let date = snapshot.get("date").and_then(Json::as_str)?;
            if !(value.is_finite() && value > 0.0 && starts_with_year_and_month(date)) {
                return None;
            }
            Some(Point { index: to_month_index(date), value, series_id: snapshot.get("series_id") })
        })
        .collect();
    // Stable, as `Array.prototype.sort` is: of two rows in one month, the later one stays later.
    points.sort_by(|a, b| a.index.partial_cmp(&b.index).unwrap_or(Ordering::Equal));
    if points.len() < 2 {
        return None;
    }

    let latest = points.last()?;
    let window_start = latest.index - (years * 12) as f64;
    let base = points.iter().find(|point| point.index >= window_start && point.series_id == latest.series_id)?;

    let span = latest.index - base.index;
    if span < MIN_SPAN_MONTHS {
        return None;
    }

    let mut result = Obj::new();
    // `Math.pow` and `powf` are both the platform's `pow`.
    result.insert("year_over_year_inflation".into(), num((latest.value / base.value).powf(12.0 / span)));
    result.insert("from".into(), json!(from_month_index(base.index)));
    result.insert("to".into(), json!(from_month_index(latest.index)));
    if let Some(series_id) = latest.series_id {
        result.insert("series_id".into(), series_id.clone());
    }
    Some(Json::Object(result))
}

/// Average inflation from the stored CPI series. Database only: never calls BLS.
pub async fn get_average_inflation() -> anyhow::Result<Option<Json>> {
    let snapshots = get_cpi_snapshots(CPI_SERIES_ID).await?;
    Ok(compute_average_inflation(&snapshots, INFLATION_AVERAGE_YEARS))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cpi(date: &str, value: f64) -> Json {
        json!({ "series_id": "CUUR0000SA0", "date": date, "value": value })
    }

    fn rate(result: &Option<Json>) -> f64 {
        result.as_ref().and_then(|r| r["year_over_year_inflation"].as_f64()).expect("a rate")
    }

    fn field<'a>(result: &'a Option<Json>, key: &str) -> &'a str {
        result.as_ref().and_then(|r| r[key].as_str()).expect("a string field")
    }

    /// `toBeCloseTo(expected, 12)`.
    #[track_caller]
    fn assert_close(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 5e-13, "{actual} is not close to {expected}");
    }

    // `inflation.test.ts`, "month index helpers".

    #[test]
    fn round_trips_a_date_through_its_month_index() {
        assert_eq!(from_month_index(to_month_index("2026-09-01")), "2026-09");
        assert_eq!(from_month_index(to_month_index("1996-12")), "1996-12");
        assert_eq!(to_month_index("2026-01-01") - to_month_index("2025-12-01"), 1.0);
    }

    #[test]
    fn month_indices_follow_javascript_numbers_outside_dates() {
        // `Number("")` is 0, so a bare year is its December of the year before.
        assert_eq!(to_month_index("2026"), 2026.0 * 12.0 - 1.0);
        assert!(to_month_index("bad").is_nan());
        assert_eq!(from_month_index(f64::NAN), "NaN-NaN");
        assert_eq!(from_month_index(0.0), "0-01");
        assert_eq!(from_month_index(-1.0), "-1-00");
        assert_eq!(from_month_index(24322.5), "2026-11.5");
    }

    // `inflation.test.ts`, "computeAverageInflation".

    #[test]
    fn is_the_compound_annual_rate_between_the_windows_first_and_last_month() {
        // Index doubles over exactly 30 years: 2^(1/30) per year.
        let result = compute_average_inflation(&[cpi("1996-09-01", 150.0), cpi("2026-09-01", 300.0)], 30);
        assert_close(rate(&result), 2f64.powf(1.0 / 30.0));
        assert_eq!(field(&result, "from"), "1996-09");
        assert_eq!(field(&result, "to"), "2026-09");
        assert_eq!(field(&result, "series_id"), "CUUR0000SA0");
        // The keys in the order the TypeScript writes them.
        let keys: Vec<&String> = result.as_ref().and_then(Json::as_object).map(|o| o.keys().collect()).unwrap_or_default();
        assert_eq!(keys, ["year_over_year_inflation", "from", "to", "series_id"]);
    }

    #[test]
    fn ignores_months_older_than_the_window() {
        let result =
            compute_average_inflation(&[cpi("1980-01-01", 50.0), cpi("2016-09-01", 200.0), cpi("2026-09-01", 220.0)], 10);
        assert_eq!(field(&result, "from"), "2016-09");
        assert_close(rate(&result), 1.1f64.powf(1.0 / 10.0));
    }

    #[test]
    fn annualizes_over_the_real_span_when_the_base_month_is_missing() {
        // 2016-09 is absent, so the base is 2016-10: 119 months, not 120.
        let result =
            compute_average_inflation(&[cpi("2016-10-01", 200.0), cpi("2020-01-01", 210.0), cpi("2026-09-01", 240.0)], 10);
        assert_eq!(field(&result, "from"), "2016-10");
        assert_close(rate(&result), 1.2f64.powf(12.0 / 119.0));
    }

    #[test]
    fn uses_whatever_history_exists_while_the_backfill_is_still_short_of_the_window() {
        let result = compute_average_inflation(&[cpi("2024-09-01", 300.0), cpi("2026-09-01", 318.0)], INFLATION_AVERAGE_YEARS);
        assert_eq!(field(&result, "from"), "2024-09");
        assert_close(rate(&result), 1.06f64.sqrt());
    }

    #[test]
    fn sorts_input_and_skips_unusable_values() {
        let result = compute_average_inflation(
            &[cpi("2026-09-01", 220.0), cpi("2025-09-01", 0.0), cpi("bad", 5.0), cpi("2016-09-01", 200.0)],
            10,
        );
        assert_eq!(field(&result, "from"), "2016-09");
        assert_eq!(field(&result, "to"), "2026-09");
    }

    #[test]
    fn skips_values_that_are_not_finite_positive_numbers() {
        let unusable = [
            json!({ "series_id": "CUUR0000SA0", "date": "2016-09-01", "value": null }),
            json!({ "series_id": "CUUR0000SA0", "date": "2016-09-01", "value": "200" }),
            json!({ "series_id": "CUUR0000SA0", "date": "2016-09-01", "value": -200 }),
            json!({ "series_id": "CUUR0000SA0", "date": "2016-09-01" }),
            json!({ "series_id": "CUUR0000SA0", "date": 20160901, "value": 200 }),
            json!({ "series_id": "CUUR0000SA0", "value": 200 }),
        ];
        for snapshot in unusable {
            assert_eq!(compute_average_inflation(&[snapshot.clone(), cpi("2026-09-01", 220.0)], 10), None, "{snapshot}");
        }
    }

    #[test]
    fn returns_null_with_less_than_a_year_of_history() {
        assert_eq!(compute_average_inflation(&[], INFLATION_AVERAGE_YEARS), None);
        assert_eq!(compute_average_inflation(&[cpi("2026-09-01", 300.0)], INFLATION_AVERAGE_YEARS), None);
        assert_eq!(
            compute_average_inflation(&[cpi("2026-01-01", 300.0), cpi("2026-09-01", 303.0)], INFLATION_AVERAGE_YEARS),
            None
        );
    }

    #[test]
    fn defaults_to_the_configured_window() {
        let old = cpi(&format!("{}-09-01", 2026 - INFLATION_AVERAGE_YEARS - 5), 100.0);
        let base = cpi(&format!("{}-09-01", 2026 - INFLATION_AVERAGE_YEARS), 150.0);
        let result = compute_average_inflation(&[old, base, cpi("2026-09-01", 300.0)], INFLATION_AVERAGE_YEARS);
        assert_eq!(field(&result, "from"), format!("{}-09", 2026 - INFLATION_AVERAGE_YEARS));
    }

    #[test]
    fn takes_the_base_from_the_latest_months_own_series() {
        let other = json!({ "series_id": "CUSR0000SA0", "date": "2016-09-01", "value": 100 });
        let result = compute_average_inflation(&[other, cpi("2018-09-01", 200.0), cpi("2026-09-01", 220.0)], 10);
        assert_eq!(field(&result, "from"), "2018-09");
        assert_eq!(field(&result, "series_id"), "CUUR0000SA0");
    }

    #[test]
    fn of_two_rows_in_the_latest_month_the_later_one_is_the_latest() {
        let result = compute_average_inflation(
            &[cpi("2016-09-01", 200.0), cpi("2026-09-01", 220.0), cpi("2026-09-15", 242.0)],
            10,
        );
        assert_close(rate(&result), 1.21f64.powf(1.0 / 10.0));
    }
}
