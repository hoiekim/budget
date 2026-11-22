//! Bureau of Labor Statistics public data API, used for Consumer Price Index
//! history behind the projection chart's auto inflation rate:
//! `src/server/lib/bls.ts`.
//! https://www.bls.gov/developers/api_signature_v2.htm
//!
//! Only the scheduled refresh (`compute_tools/refresh_cpi_snapshots.rs`) calls
//! this module. Client requests read the stored rows and never reach BLS.
//!
//! How the TypeScript's shapes map here:
//!
//! - `BlsResult<T>` is `Result<T, BlsFailure>`. `{ success: true, data }` is
//!   `Ok(data)`; `{ success: false, error, message }` is `Err(BlsFailure {
//!   error, message })`, `error` being a [`BlsErrorKind`] whose `as_str()` is
//!   the TypeScript's string.
//! - `getCpiSeries`'s optional `seriesId` is an `Option<&str>`; `None` is
//!   [`CPI_SERIES_ID`].
//! - `parseCpiObservations` returns `Result<…, Thrown>`: the `Err` is a body
//!   the TypeScript throws on (`null`, or rows that cannot be walked).
//!   [`get_cpi_series`] itself never fails outside its `BlsResult`.

use std::sync::{LazyLock, Mutex};

use regex::Regex;
use serde_json::json;

use crate::common::date::ONE_DAY;
use crate::common::queue::Queue;
use crate::js::{self, json_stringify, Json, JsDate};
use crate::server::alarm::http_client;
use crate::server::logger;
use crate::server::polygon::{
    element_at, fetch_error_message, is_ok, member, non_nullish, optional_member, response_json, to_number, Thrown,
};

const BLS_HOST: &str = "https://api.bls.gov";

/// CPI-U, U.S. city average, all items, not seasonally adjusted (1982-84 = 100).
pub const CPI_SERIES_ID: &str = "CUUR0000SA0";

/// Read at call time, so the tier follows the environment. Unset and empty
/// both mean "no key".
fn get_api_key() -> Option<String> {
    std::env::var("BLS_API_KEY").ok().filter(|key| !key.is_empty())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlsTier {
    /// `"v1"` or `"v2"`.
    pub version: &'static str,
    /// The daily request cap BLS enforces for this tier.
    pub daily_limit: i64,
    /// How many requests this process lets itself make per rolling 24 hours.
    pub daily_budget: i64,
    /// The widest `startyear..endyear` span one request may ask for.
    pub max_years_per_request: i64,
}

/// BLS publishes two tiers. Without a registration key the v1 endpoint allows
/// 25 requests a day at 10 years each; with one, v2 allows 500 a day at 20
/// years each. `daily_budget` is this process's share, counted in memory: a
/// restart starts a fresh count, and BLS's cap is per key or IP, shared with
/// anything else using it.
pub fn get_bls_tier() -> BlsTier {
    if get_api_key().is_some() {
        BlsTier { version: "v2", daily_limit: 500, daily_budget: 50, max_years_per_request: 20 }
    } else {
        BlsTier { version: "v1", daily_limit: 25, daily_budget: 10, max_years_per_request: 10 }
    }
}

static BUDGET_QUEUE: LazyLock<Queue> = LazyLock::new(|| Queue::new(|| get_bls_tier().daily_budget, ONE_DAY));

/// Set by a "daily threshold" refusal: no request goes out before this time.
static PAUSED_UNTIL: Mutex<f64> = Mutex::new(0.0);

/// Forget every request counted against the daily budget (tests only).
pub fn reset_bls_request_budget() {
    BUDGET_QUEUE.reset();
    *PAUSED_UNTIL.lock().unwrap() = 0.0;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CpiObservation {
    pub year: i64,
    /// 1-12
    pub month: i64,
    pub value: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlsErrorKind {
    ApiError,
    NoData,
    RateLimited,
    BudgetExhausted,
}

impl BlsErrorKind {
    /// The TypeScript's `error` string.
    pub fn as_str(self) -> &'static str {
        match self {
            BlsErrorKind::ApiError => "api_error",
            BlsErrorKind::NoData => "no_data",
            BlsErrorKind::RateLimited => "rate_limited",
            BlsErrorKind::BudgetExhausted => "budget_exhausted",
        }
    }
}

/// The failed half of a `BlsResult`.
#[derive(Clone, Debug, PartialEq)]
pub struct BlsFailure {
    pub error: BlsErrorKind,
    pub message: String,
}

impl BlsFailure {
    pub fn new(error: BlsErrorKind, message: impl Into<String>) -> Self {
        BlsFailure { error, message: message.into() }
    }
}

pub type BlsResult<T> = Result<T, BlsFailure>;

/// `M01`..`M12`. `M13` is the annual average and is not a month.
static MONTHLY_PERIOD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^M(0[1-9]|1[0-2])$").unwrap());

static THRESHOLD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)threshold").unwrap());

/// The strings of BLS's `message` array, joined; anything else is no message.
fn messages_of(message: Option<&Json>) -> String {
    match message {
        Some(Json::Array(messages)) => messages.iter().filter_map(Json::as_str).collect::<Vec<_>>().join("; "),
        _ => String::new(),
    }
}

/// BLS answers a refused request with HTTP 200 and a status other than
/// `REQUEST_SUCCEEDED`. Running past the daily cap reads "…daily threshold…";
/// that one pauses this process's BLS requests for a day (`PAUSED_UNTIL`)
/// instead of being retried every hour.
fn refusal(body: &Json) -> Result<Option<BlsFailure>, Thrown> {
    if body.is_null() {
        return Err(Thrown::new("null is not an object (evaluating 'body.status')"));
    }
    let status = member(body, "status");
    if status.and_then(Json::as_str) == Some("REQUEST_SUCCEEDED") {
        return Ok(None);
    }
    let mut message = messages_of(member(body, "message"));
    if message.is_empty() {
        let status = status.map(js::to_js_string).unwrap_or_else(|| "undefined".to_string());
        message = format!("BLS request status {status}");
    }
    let error = if THRESHOLD.is_match(&message) { BlsErrorKind::RateLimited } else { BlsErrorKind::ApiError };
    Ok(Some(BlsFailure::new(error, message)))
}

/// Parse one series' observations. Months BLS could not publish carry a
/// non-numeric value (October 2025 reads `-`: the index was not collected
/// during that year's lapse in appropriations), so they are dropped rather
/// than stored as zero.
pub fn parse_cpi_observations(body: &Json) -> Result<Vec<CpiObservation>, Thrown> {
    if body.is_null() {
        return Err(Thrown::new("null is not an object (evaluating 'body.Results')"));
    }
    // `body.Results?.series?.[0]?.data ?? []`
    let series = non_nullish(optional_member(non_nullish(member(body, "Results")), "series"));
    let first = series.and_then(|series| element_at(series, 0));
    let data = first.as_deref().and_then(|first| non_nullish(member(first, "data")));
    let rows: &[Json] = match data {
        // A string is walked character by character, and no character is a row.
        None | Some(Json::Null) | Some(Json::String(_)) => &[],
        Some(Json::Array(rows)) => rows,
        Some(Json::Object(_)) => return Err(Thrown::new("{} is not iterable")),
        Some(Json::Bool(flag)) => return Err(Thrown::new(format!("{flag} is not iterable"))),
        Some(Json::Number(_)) => return Err(Thrown::new("number is not iterable")),
    };

    let mut observations: Vec<CpiObservation> = Vec::new();
    for row in rows {
        if row.is_null() {
            return Err(Thrown::new("null is not an object (evaluating 'row.period')"));
        }
        let period = non_nullish(member(row, "period"));
        let period_text = period.map(js::to_js_string).unwrap_or_default();
        if !MONTHLY_PERIOD.is_match(&period_text) {
            continue;
        }
        let year = to_number(member(row, "year"));
        let value = to_number(member(row, "value"));
        if !year.is_finite() || year.fract() != 0.0 || !value.is_finite() || value <= 0.0 {
            continue;
        }
        // `Number(period.slice(1))`: the digits after the `M`. A one-item list
        // reads as its item above, and its slice is empty, which is zero.
        let month = match period {
            Some(Json::Array(_)) => 0,
            _ => period_text.get(1..).and_then(|digits| digits.parse::<i64>().ok()).unwrap_or(0),
        };
        observations.push(CpiObservation { year: year as i64, month, value });
    }
    observations.sort_by(|a, b| a.year.cmp(&b.year).then(a.month.cmp(&b.month)));
    Ok(observations)
}

/// The endpoint for a tier.
fn series_url(tier: &BlsTier) -> String {
    format!("{BLS_HOST}/publicAPI/{}/timeseries/data/", tier.version)
}

/// The JSON a series request posts.
fn request_body(series_id: &str, start_year: i64, end_year: i64, api_key: Option<&str>) -> String {
    let mut body = json!({
        "seriesid": [series_id],
        "startyear": start_year.to_string(),
        "endyear": end_year.to_string(),
    });
    if let (Some(api_key), Some(object)) = (api_key, body.as_object_mut()) {
        object.insert("registrationkey".into(), Json::String(api_key.to_string()));
    }
    json_stringify(&body)
}

/// Fetch one series between two calendar years, inclusive, in a single request.
/// Callers split longer spans with `get_bls_tier().max_years_per_request`; a
/// span wider than that is rejected up front instead of spending a request BLS
/// would refuse.
pub async fn get_cpi_series(start_year: i64, end_year: i64, series_id: Option<&str>) -> BlsResult<Vec<CpiObservation>> {
    let series_id = series_id.unwrap_or(CPI_SERIES_ID);
    let tier = get_bls_tier();
    let span = end_year - start_year + 1;
    if span < 1 || span > tier.max_years_per_request {
        return Err(BlsFailure::new(
            BlsErrorKind::ApiError,
            format!("BLS {} accepts 1-{} years per request, asked for {span}", tier.version, tier.max_years_per_request),
        ));
    }

    let paused_until = *PAUSED_UNTIL.lock().unwrap();
    if JsDate::now_ms() < paused_until {
        return Err(BlsFailure::new(
            BlsErrorKind::BudgetExhausted,
            format!(
                "BLS refused for its daily threshold; paused until {}",
                JsDate::from_ms(paused_until).to_iso_string().unwrap_or_default()
            ),
        ));
    }

    let api_key = get_api_key();
    let url = series_url(&tier);
    let body = request_body(series_id, start_year, end_year, api_key.as_deref());

    let request = || http_client().post(&url).header("Content-Type", "application/json").body(body).send();
    // Fail fast on a spent budget: 0 would wait forever for a slot hours away.
    let response = match BUDGET_QUEUE.add(request, Some(1.0)).await {
        Err(_budget_spent) => {
            return Err(BlsFailure::new(
                BlsErrorKind::BudgetExhausted,
                format!("BLS daily request budget ({}) is spent", tier.daily_budget),
            ));
        }
        Ok(sent) => sent.map_err(|error| Thrown::new(fetch_error_message(&error))),
    };

    let attempt = async {
        let response = response?;
        let status = response.status().as_u16();
        if !is_ok(status) {
            return Ok(Err(BlsFailure::new(BlsErrorKind::ApiError, format!("BLS HTTP {status}"))));
        }
        let json = response_json(response).await?;
        if let Some(refused) = refusal(&json)? {
            if refused.error == BlsErrorKind::RateLimited {
                *PAUSED_UNTIL.lock().unwrap() = JsDate::now_ms() + ONE_DAY;
            }
            return Ok(Err(refused));
        }

        let observations = parse_cpi_observations(&json)?;
        if observations.is_empty() {
            return Ok(Err(BlsFailure::new(
                BlsErrorKind::NoData,
                format!("No {series_id} data for {start_year}-{end_year}"),
            )));
        }
        Ok::<BlsResult<Vec<CpiObservation>>, Thrown>(Ok(observations))
    };
    match attempt.await {
        Ok(result) => result,
        Err(Thrown(message)) => {
            logger::error(
                &format!("BLS API error for {series_id}: {message}"),
                Some(&crate::ctx! { "component": "bls" }),
                None,
            );
            Err(BlsFailure::new(BlsErrorKind::ApiError, message))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::polygon::tests::{with_env, with_env_sync};

    fn ok_body(data: Json) -> Json {
        json!({
            "status": "REQUEST_SUCCEEDED",
            "message": [],
            "Results": { "series": [{ "seriesID": "CUUR0000SA0", "data": data }] },
        })
    }

    const DAILY_THRESHOLD: &str =
        "The daily threshold for total number of requests allocated to the user has been reached.";

    #[test]
    fn keyless_deployments_use_v1_and_spend_well_under_its_25_a_day_cap() {
        let tier = with_env_sync(&[("BLS_API_KEY", None)], get_bls_tier);
        assert_eq!(tier.version, "v1");
        assert_eq!(tier.max_years_per_request, 10);
        assert!(tier.daily_budget <= tier.daily_limit / 2);
        assert_eq!(series_url(&tier), "https://api.bls.gov/publicAPI/v1/timeseries/data/");
        // An empty key is no key.
        assert_eq!(with_env_sync(&[("BLS_API_KEY", Some(""))], get_bls_tier).version, "v1");
    }

    #[test]
    fn a_registration_key_moves_to_v2_and_stays_well_under_its_500_a_day_cap() {
        let tier = with_env_sync(&[("BLS_API_KEY", Some("key"))], get_bls_tier);
        assert_eq!(tier.version, "v2");
        assert_eq!(tier.max_years_per_request, 20);
        assert!(tier.daily_budget <= tier.daily_limit / 2);
        assert_eq!(series_url(&tier), "https://api.bls.gov/publicAPI/v2/timeseries/data/");
    }

    #[test]
    fn keeps_monthly_periods_drops_the_annual_average_and_unpublished_months() {
        let parsed = parse_cpi_observations(&ok_body(json!([
            { "year": "2025", "period": "M13", "value": "322.0" },
            { "year": "2025", "period": "M11", "value": "324.1" },
            // BLS publishes October 2025 as "-" (not collected during the shutdown).
            { "year": "2025", "period": "M10", "value": "-" },
            { "year": "2025", "period": "M09", "value": "324.8" },
            { "year": "2025", "period": "S01", "value": "321.0" },
        ])));
        assert_eq!(
            parsed,
            Ok(vec![
                CpiObservation { year: 2025, month: 9, value: 324.8 },
                CpiObservation { year: 2025, month: 11, value: 324.1 },
            ])
        );
    }

    #[test]
    fn orders_observations_by_year_then_month() {
        let parsed = parse_cpi_observations(&ok_body(json!([
            { "year": "2026", "period": "M01", "value": "320.5" },
            { "year": "2025", "period": "M12", "value": "319" },
            { "year": "2025", "period": "M02", "value": "318.25" },
            { "year": "2025.5", "period": "M03", "value": "1" },
            { "year": "2025", "period": "M04", "value": "0" },
            { "year": "2025", "period": "M05" },
            { "period": "M06", "value": "1" },
            "M07",
        ])))
        .unwrap();
        assert_eq!(
            parsed.iter().map(|o| (o.year, o.month, o.value)).collect::<Vec<_>>(),
            vec![(2025, 2, 318.25), (2025, 12, 319.0), (2026, 1, 320.5)]
        );
    }

    #[test]
    fn tolerates_a_body_with_no_series() {
        assert_eq!(parse_cpi_observations(&json!({ "status": "REQUEST_SUCCEEDED" })), Ok(vec![]));
        assert_eq!(parse_cpi_observations(&json!({ "Results": { "series": [] } })), Ok(vec![]));
        assert_eq!(parse_cpi_observations(&json!({ "Results": null })), Ok(vec![]));
        assert!(parse_cpi_observations(&Json::Null).is_err());
    }

    #[test]
    fn posts_the_series_and_year_span() {
        assert_eq!(
            request_body(CPI_SERIES_ID, 2016, 2025, None),
            r#"{"seriesid":["CUUR0000SA0"],"startyear":"2016","endyear":"2025"}"#
        );
        // The registration key rides along when one is configured.
        assert_eq!(
            request_body(CPI_SERIES_ID, 2006, 2025, Some("secret")),
            r#"{"seriesid":["CUUR0000SA0"],"startyear":"2006","endyear":"2025","registrationkey":"secret"}"#
        );
    }

    #[tokio::test]
    async fn refuses_a_span_wider_than_the_tier_allows_without_spending_a_request() {
        with_env(&[("BLS_API_KEY", None)], async {
            let result = get_cpi_series(2006, 2025, None).await;
            assert_eq!(
                result,
                Err(BlsFailure::new(BlsErrorKind::ApiError, "BLS v1 accepts 1-10 years per request, asked for 20"))
            );
            let backwards = get_cpi_series(2026, 2025, None).await;
            assert_eq!(backwards.unwrap_err().message, "BLS v1 accepts 1-10 years per request, asked for 0");
        })
        .await;
        with_env(&[("BLS_API_KEY", Some("key"))], async {
            let result = get_cpi_series(2005, 2025, Some("CUSR0000SA0")).await;
            assert_eq!(result.unwrap_err().message, "BLS v2 accepts 1-20 years per request, asked for 21");
        })
        .await;
    }

    #[test]
    fn reports_blss_daily_threshold_refusal_as_rate_limited() {
        let refused = refusal(&json!({ "status": "REQUEST_NOT_PROCESSED", "message": [DAILY_THRESHOLD] })).unwrap();
        assert_eq!(refused, Some(BlsFailure::new(BlsErrorKind::RateLimited, DAILY_THRESHOLD)));
    }

    #[test]
    fn reports_any_other_refusal_as_api_error_with_blss_message() {
        let refused =
            refusal(&json!({ "status": "REQUEST_FAILED_INVALID_PARAMETERS", "message": ["Invalid Series"] })).unwrap();
        assert_eq!(refused, Some(BlsFailure::new(BlsErrorKind::ApiError, "Invalid Series")));
        // Several messages join; one that is not text is left out; none at all names the status.
        let joined = refusal(&json!({ "status": "REQUEST_FAILED", "message": ["a", 5, "b"] })).unwrap().unwrap();
        assert_eq!(joined.message, "a; b");
        let bare = refusal(&json!({ "status": "REQUEST_FAILED", "message": [] })).unwrap().unwrap();
        assert_eq!(bare.message, "BLS request status REQUEST_FAILED");
        assert_eq!(refusal(&json!({})).unwrap().unwrap().message, "BLS request status undefined");
        assert_eq!(refusal(&ok_body(json!([]))), Ok(None));
        assert!(refusal(&Json::Null).is_err());
    }

    #[tokio::test]
    async fn stops_at_the_daily_budget_instead_of_waiting_for_a_slot() {
        with_env(&[("BLS_API_KEY", None)], async {
            reset_bls_request_budget();
            let budget = get_bls_tier().daily_budget;
            for _ in 0..budget {
                BUDGET_QUEUE.add(|| async {}, Some(1.0)).await.unwrap();
            }
            let started = JsDate::now_ms();
            let over = get_cpi_series(2025, 2026, None).await;
            assert_eq!(
                over,
                Err(BlsFailure::new(BlsErrorKind::BudgetExhausted, "BLS daily request budget (10) is spent"))
            );
            assert!(JsDate::now_ms() - started < 1000.0);
            // Forgetting the count makes room again.
            reset_bls_request_budget();
            assert!(BUDGET_QUEUE.add(|| async {}, Some(1.0)).await.is_ok());
            reset_bls_request_budget();
        })
        .await;
    }

    #[tokio::test]
    async fn a_daily_threshold_pause_stops_requests_until_it_lifts() {
        with_env(&[("BLS_API_KEY", None)], async {
            let until = JsDate::now_ms() + ONE_DAY;
            *PAUSED_UNTIL.lock().unwrap() = until;
            let result = get_cpi_series(2025, 2026, None).await;
            *PAUSED_UNTIL.lock().unwrap() = 0.0;
            assert_eq!(
                result,
                Err(BlsFailure::new(
                    BlsErrorKind::BudgetExhausted,
                    format!(
                        "BLS refused for its daily threshold; paused until {}",
                        JsDate::from_ms(until).to_iso_string().unwrap()
                    )
                ))
            );
        })
        .await;
    }
}
