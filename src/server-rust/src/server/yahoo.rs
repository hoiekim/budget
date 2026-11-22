//! Yahoo Finance chart API as the keyless fallback for tickers Polygon does
//! not carry, chiefly mutual funds (e.g. VFIAX), which are NAV-priced and
//! never touch an exchange tape: `src/server/lib/yahoo.ts`. Unofficial
//! endpoint; it is only ever consulted after Polygon answers `no_data`,
//! never as the primary source.
//!
//! https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=5d
//!
//! The results are `polygon.rs`'s: `PolygonResult<T>` is `Result<T,
//! PolygonFailure>`, the options are a `LookupOptions`, a `Date | string` is
//! a `DateOrString` (see the top of that file). A chart, the TypeScript's
//! `YahooChartResult`, stays the JSON Yahoo sent. Every lookup here returns
//! `anyhow::Result<…>`: the `Err` is the one place the TypeScript throws, an
//! answer whose JSON is `null` (an empty body included).

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, Once};

use crate::common::date::get_date_string;
use crate::common::queue::Queue;
use crate::js::{self, encode_uri_component, number_to_string, Json, JsDate};
use crate::server::alarm::http_client;
use crate::server::logger;
use crate::server::polygon::{
    compare_strings, element_at, fetch_error_message, member, non_nullish, optional_member, rate_limit_per_min,
    response_json, start_cache_sweep, to_number, Close, DateOrString, LookupOptions, PolygonErrorKind, PolygonFailure,
    PolygonResult, TickerDetail,
};

pub const YAHOO_HOST: &str = "https://query1.finance.yahoo.com";

// Yahoo rejects non-browser user agents on this endpoint.
const USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Yahoo is unofficial and IP-rate-limited, so keep the cadence gentle. The
// fallback only fires on Polygon misses, which are rare by construction.
const DEFAULT_RATE_LIMIT_PER_MIN: i64 = 30;

fn get_rate_limit_per_min() -> i64 {
    rate_limit_per_min(std::env::var("YAHOO_RATE_LIMIT_PER_MIN").ok().as_deref(), DEFAULT_RATE_LIMIT_PER_MIN)
}

pub static YAHOO_QUEUE: LazyLock<Queue> = LazyLock::new(|| Queue::new(get_rate_limit_per_min, 60_000.0));

/// Same foreground budget as Polygon: a form should fail retryable, not hang.
pub const FOREGROUND_QUEUE_WAIT_MS: f64 = 5_000.0;

/// Yahoo's crypto convention is `{BASE}-USD` (e.g. `BTC-USD`), mirroring
/// Polygon's `X:{BASE}USD` mapping in `to_polygon_ticker`.
pub fn to_yahoo_ticker(ticker_symbol: &str, security_type: Option<&str>) -> String {
    if security_type != Some("cryptocurrency") {
        return ticker_symbol.to_string();
    }
    if ticker_symbol.ends_with("-USD") {
        return ticker_symbol.to_string();
    }
    format!("{ticker_symbol}-USD")
}

const CACHE_TTL_MS: f64 = 60.0 * 60.0 * 1000.0; // 1 hour
const MISS_CACHE_TTL_MS: f64 = 5.0 * 60.0 * 1000.0; // 5 minutes

/// Closes by `{yahooTicker}:{dateString}`, with the time each was fetched.
static PRICE_CACHE: LazyLock<Mutex<HashMap<String, (f64, f64)>>> = LazyLock::new(Default::default);

/// Lookups that came back empty, by the time they did.
static MISS_CACHE: LazyLock<Mutex<HashMap<String, f64>>> = LazyLock::new(Default::default);

/// Ticker details by Yahoo ticker, with the time each was fetched.
static DETAIL_CACHE: LazyLock<Mutex<HashMap<String, (TickerDetail, f64)>>> = LazyLock::new(Default::default);

fn is_recent_miss(key: &str) -> bool {
    let mut misses = MISS_CACHE.lock().unwrap();
    let Some(missed_at) = misses.get(key).copied() else { return false };
    if JsDate::now_ms() - missed_at >= MISS_CACHE_TTL_MS {
        misses.remove(key);
        return false;
    }
    true
}

fn remember_miss(key: &str) {
    MISS_CACHE.lock().unwrap().insert(key.to_string(), JsDate::now_ms());
    start_cache_sweep(&SWEEP, sweep_caches);
}

static SWEEP: Once = Once::new();

fn sweep_caches() {
    let now = JsDate::now_ms();
    PRICE_CACHE.lock().unwrap().retain(|_, (_, fetched_at)| now - *fetched_at < CACHE_TTL_MS);
    MISS_CACHE.lock().unwrap().retain(|_, missed_at| now - *missed_at < MISS_CACHE_TTL_MS);
    DETAIL_CACHE.lock().unwrap().retain(|_, (_, fetched_at)| now - *fetched_at < CACHE_TTL_MS);
}

fn rate_limited_result(ticker: &str) -> PolygonFailure {
    PolygonFailure::new(
        PolygonErrorKind::RateLimited,
        format!("Market data is busy right now; retry the lookup for {ticker} in a moment."),
    )
}

fn chart_url(yahoo_ticker: &str, query: &str) -> String {
    format!("{YAHOO_HOST}/v8/finance/chart/{}?{query}", encode_uri_component(yahoo_ticker))
}

/// `json.chart?.result?.[0]` of an answer that is not `null`, when it is truthy.
fn chart_result(json: &Json) -> Option<Cow<'_, Json>> {
    let results = non_nullish(optional_member(non_nullish(member(json, "chart")), "result"))?;
    element_at(results, 0).filter(|result| js::truthy(result))
}

/// Fetch one chart response. A 200 with `chart.error` (or a null result) is
/// Yahoo's "no such symbol", the only answer that may be memoized as a miss.
/// 429 is a refusal, not a verdict on the symbol.
pub async fn fetch_chart(yahoo_ticker: &str, query: &str, max_wait_ms: Option<f64>) -> anyhow::Result<PolygonResult<Json>> {
    let path = chart_url(yahoo_ticker, query);
    let request = || http_client().get(&path).header("User-Agent", USER_AGENT).header("Accept", "application/json").send();
    let response = match YAHOO_QUEUE.add(request, max_wait_ms).await {
        Err(_waited_too_long) => return Ok(Err(rate_limited_result(yahoo_ticker))),
        Ok(Err(error)) => {
            let message = fetch_error_message(&error);
            logger::error(
                &format!("Yahoo API error for {yahoo_ticker}: {message}"),
                Some(&crate::ctx! { "component": "yahoo" }),
                None,
            );
            return Ok(Err(PolygonFailure::new(
                PolygonErrorKind::ApiError,
                format!("Failed to fetch {yahoo_ticker}: {message}"),
            )));
        }
        Ok(Ok(response)) => response,
    };

    if response.status().as_u16() == 429 {
        return Ok(Err(rate_limited_result(yahoo_ticker)));
    }

    let json = match response_json(response).await {
        Ok(json) => json,
        Err(thrown) => {
            return Ok(Err(PolygonFailure::new(
                PolygonErrorKind::ApiError,
                format!("Bad response for {yahoo_ticker}: {thrown}"),
            )));
        }
    };

    if json.is_null() {
        // The TypeScript reads `json.chart` of whatever parsed.
        anyhow::bail!("null is not an object (evaluating 'json.chart')");
    }
    match chart_result(&json) {
        Some(result) => Ok(Ok(result.into_owned())),
        None => Ok(Err(PolygonFailure::new(
            PolygonErrorKind::NoData,
            format!("No Yahoo data found for {yahoo_ticker}"),
        ))),
    }
}

/// The UTC day of a bar's timestamp, which is in seconds.
pub fn date_string_of_timestamp(t: f64) -> String {
    let date = JsDate::from_ms(t * 1000.0);
    if !date.is_valid() {
        return "NaN-NaN-NaN".to_string();
    }
    format!("{}-{:02}-{:02}", date.get_utc_full_year(), date.get_utc_month() + 1, date.get_utc_date())
}

/// `chart.timestamp ?? []`.
pub(crate) fn timestamps_of(chart: &Json) -> Option<&Json> {
    non_nullish(member(chart, "timestamp"))
}

/// `chart.indicators?.[group]?.[0]?.[field] ?? []`: the closes are
/// `("quote", "close")`, the adjusted closes `("adjclose", "adjclose")`.
pub(crate) fn series_of<'a>(chart: &'a Json, group: &str, field: &str) -> Option<&'a Json> {
    let groups = non_nullish(optional_member(non_nullish(member(chart, "indicators")), group))?;
    match element_at(groups, 0)? {
        Cow::Borrowed(first) => non_nullish(member(first, field)),
        // A character of a string has no fields.
        Cow::Owned(_) => None,
    }
}

/// `values.length` as a loop bound: an array's or a string's, or the number
/// an object carries under that name. Anything else has none, and no loop runs.
pub(crate) fn length_of(values: Option<&Json>) -> usize {
    match values {
        Some(Json::Array(items)) => items.len(),
        Some(Json::String(text)) => js::js_length(text),
        Some(Json::Object(object)) => {
            let length = to_number(object.get("length"));
            if length.is_nan() || length <= 0.0 {
                0
            } else {
                // `i < length` holds for every index below it; no chart has more bars than this.
                length.ceil().min(1_000_000.0) as usize
            }
        }
        _ => 0,
    }
}

/// `values[index]` when it is a finite number.
pub(crate) fn number_at(values: Option<&Json>, index: usize) -> Option<f64> {
    match values.and_then(|values| element_at(values, index)).as_deref() {
        Some(Json::Number(number)) => number.as_f64().filter(|value| value.is_finite()),
        _ => None,
    }
}

/// `dateStringOfTimestamp(timestamps[index])`.
pub(crate) fn date_at(timestamps: Option<&Json>, index: usize) -> String {
    date_string_of_timestamp(to_number(timestamps.and_then(|values| element_at(values, index)).as_deref()))
}

fn detail_of(ticker_symbol: &str, chart: &Json) -> TickerDetail {
    let meta = non_nullish(member(chart, "meta"));
    let truthy = |key: &str| optional_member(meta, key).filter(|value| js::truthy(value)).cloned();
    TickerDetail {
        ticker_symbol: ticker_symbol.to_string(),
        name: truthy("longName").or_else(|| truthy("shortName")).or_else(|| Some(Json::String(ticker_symbol.to_string()))),
        currency_name: truthy("currency").or_else(|| Some(Json::String("USD".to_string()))),
    }
}

pub async fn get_ticker_detail(ticker_symbol: &str, options: &LookupOptions) -> anyhow::Result<PolygonResult<TickerDetail>> {
    let yahoo_ticker = to_yahoo_ticker(ticker_symbol, options.security_type.as_deref());

    if let Some((detail, fetched_at)) = DETAIL_CACHE.lock().unwrap().get(&yahoo_ticker) {
        if JsDate::now_ms() - fetched_at < CACHE_TTL_MS {
            return Ok(Ok(detail.clone()));
        }
    }

    let miss_key = format!("detail:{yahoo_ticker}");
    let no_data = || PolygonFailure::new(PolygonErrorKind::NoData, format!("No Yahoo data found for {ticker_symbol}"));
    if is_recent_miss(&miss_key) {
        return Ok(Err(no_data()));
    }

    let chart = match fetch_chart(&yahoo_ticker, "interval=1d&range=5d", options.max_wait_ms).await? {
        Ok(chart) => chart,
        Err(failure) if failure.error == PolygonErrorKind::NoData => {
            remember_miss(&miss_key);
            return Ok(Err(no_data()));
        }
        Err(failure) => return Ok(Err(failure)),
    };

    let detail = detail_of(ticker_symbol, &chart);
    DETAIL_CACHE.lock().unwrap().insert(yahoo_ticker, (detail.clone(), JsDate::now_ms()));
    start_cache_sweep(&SWEEP, sweep_caches);
    Ok(Ok(detail))
}

/// The query for the bars around one day: a 3-day window around the target.
fn close_price_query(date_string: &str) -> String {
    let day_ms = 24.0 * 60.0 * 60.0 * 1000.0;
    let target = JsDate::parse(&format!("{date_string}T00:00:00Z")).get_time();
    let period1 = ((target - day_ms) / 1000.0).floor();
    let period2 = ((target + 2.0 * day_ms) / 1000.0).floor();
    format!("interval=1d&period1={}&period2={}", number_to_string(period1), number_to_string(period2))
}

/// The close of the bar whose UTC date is `date_string`. Mutual-fund NAV bars
/// land on the date itself.
fn close_on(chart: &Json, date_string: &str) -> Option<f64> {
    let timestamps = timestamps_of(chart);
    let closes = series_of(chart, "quote", "close");
    (0..length_of(timestamps))
        .filter(|index| date_at(timestamps, *index) == date_string)
        .find_map(|index| number_at(closes, index))
}

pub async fn get_close_price(ticker_symbol: &str, date: JsDate, options: &LookupOptions) -> anyhow::Result<PolygonResult<f64>> {
    let yahoo_ticker = to_yahoo_ticker(ticker_symbol, options.security_type.as_deref());
    let date_string = get_date_string(date);
    let cache_key = format!("{yahoo_ticker}:{date_string}");

    if let Some((price, fetched_at)) = PRICE_CACHE.lock().unwrap().get(&cache_key) {
        if JsDate::now_ms() - fetched_at < CACHE_TTL_MS {
            return Ok(Ok(*price));
        }
    }

    let miss_key = format!("price:{cache_key}");
    let no_data = || {
        PolygonFailure::new(
            PolygonErrorKind::NoData,
            format!("No Yahoo price data available for {ticker_symbol} on {date_string}"),
        )
    };
    if is_recent_miss(&miss_key) {
        return Ok(Err(no_data()));
    }

    let chart = match fetch_chart(&yahoo_ticker, &close_price_query(&date_string), options.max_wait_ms).await? {
        Ok(chart) => chart,
        Err(failure) if failure.error == PolygonErrorKind::NoData => {
            remember_miss(&miss_key);
            return Ok(Err(no_data()));
        }
        Err(failure) => return Ok(Err(failure)),
    };

    if let Some(close) = close_on(&chart, &date_string) {
        PRICE_CACHE.lock().unwrap().insert(cache_key, (close, JsDate::now_ms()));
        start_cache_sweep(&SWEEP, sweep_caches);
        return Ok(Ok(close));
    }

    remember_miss(&miss_key);
    Ok(Err(no_data()))
}

/// The latest bar with a close at or before `to`.
fn latest_close_on_or_before(chart: &Json, to: &str) -> Option<Close> {
    let timestamps = timestamps_of(chart);
    let closes = series_of(chart, "quote", "close");
    (0..length_of(timestamps)).rev().find_map(|index| {
        let trading_date = date_at(timestamps, index);
        if compare_strings(&trading_date, to).is_gt() {
            return None;
        }
        number_at(closes, index).map(|price| Close { price, trading_date })
    })
}

/// Latest daily close at or before `date`, mirroring Polygon's
/// `get_latest_close_price_on_or_before`, the refresh pass's trading-day resolver.
pub async fn get_latest_close_price_on_or_before(
    ticker_symbol: &str,
    date_or_string: impl Into<DateOrString>,
    options: &LookupOptions,
) -> anyhow::Result<PolygonResult<Close>> {
    let lookback_days = options.lookback_days.unwrap_or(7);
    let yahoo_ticker = to_yahoo_ticker(ticker_symbol, options.security_type.as_deref());

    let to = date_or_string.into().to_day();

    let miss_key = format!("range:{yahoo_ticker}:{to}:{lookback_days}");
    let no_data = || {
        PolygonFailure::new(
            PolygonErrorKind::NoData,
            format!("No Yahoo price data for {ticker_symbol} on or before {to}"),
        )
    };
    if is_recent_miss(&miss_key) {
        return Ok(Err(no_data()));
    }

    let query = format!("interval=1d&range={}d", lookback_days + 2);
    let chart = match fetch_chart(&yahoo_ticker, &query, options.max_wait_ms).await? {
        Ok(chart) => chart,
        Err(failure) if failure.error == PolygonErrorKind::NoData => {
            remember_miss(&miss_key);
            return Ok(Err(no_data()));
        }
        Err(failure) => return Ok(Err(failure)),
    };

    if let Some(latest) = latest_close_on_or_before(&chart, &to) {
        return Ok(Ok(latest));
    }

    remember_miss(&miss_key);
    Ok(Err(no_data()))
}

/// Clear the price cache, the ticker-detail cache and the empty-result memo
/// (useful for testing)
pub fn clear_yahoo_cache() {
    PRICE_CACHE.lock().unwrap().clear();
    DETAIL_CACHE.lock().unwrap().clear();
    MISS_CACHE.lock().unwrap().clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::polygon::tests::with_env;
    use serde_json::json;

    fn ts(year: i64, month: i64, day: i64) -> f64 {
        (JsDate::from_utc(year, month - 1, day, 0, 0, 0, 0).get_time() / 1000.0).floor()
    }

    /// The first result of a chart answer with the fund's meta and three bars.
    fn chart_ok(timestamps: Json, closes: Json) -> Json {
        json!({
            "meta": {
                "currency": "USD",
                "longName": "Vanguard 500 Index Admiral",
                "shortName": "Vanguard 500 Index Fd Admiral S",
                "instrumentType": "MUTUALFUND",
                "regularMarketPrice": 720.06,
            },
            "timestamp": timestamps,
            "indicators": { "quote": [{ "close": closes }] },
        })
    }

    fn october_chart() -> Json {
        chart_ok(json!([ts(2026, 10, 5), ts(2026, 10, 6), ts(2026, 10, 7)]), json!([718.5, 720.06, 721.0]))
    }

    #[test]
    fn maps_crypto_to_yahoos_base_usd_convention() {
        assert_eq!(to_yahoo_ticker("BTC", Some("cryptocurrency")), "BTC-USD");
        assert_eq!(to_yahoo_ticker("BTC-USD", Some("cryptocurrency")), "BTC-USD");
    }

    #[test]
    fn passes_equities_through_untouched() {
        assert_eq!(to_yahoo_ticker("VFIAX", None), "VFIAX");
        assert_eq!(to_yahoo_ticker("AAPL", Some("equity")), "AAPL");
    }

    #[test]
    fn chart_requests_encode_the_ticker() {
        assert_eq!(
            chart_url("VFIAX", "interval=1d&range=5d"),
            "https://query1.finance.yahoo.com/v8/finance/chart/VFIAX?interval=1d&range=5d"
        );
        assert_eq!(chart_url("X:BTC/USD", "a=1"), "https://query1.finance.yahoo.com/v8/finance/chart/X%3ABTC%2FUSD?a=1");
        assert!(USER_AGENT.starts_with("Mozilla/"));
    }

    #[test]
    fn the_first_chart_result_is_the_answer() {
        let json = json!({ "chart": { "result": [{ "meta": {} }], "error": null } });
        assert_eq!(chart_result(&json).as_deref(), Some(&json!({ "meta": {} })));
        // An unknown symbol: a null result and an error.
        let not_found = json!({
            "chart": { "result": null, "error": { "code": "Not Found", "description": "No data found, symbol may be delisted" } },
        });
        assert_eq!(chart_result(&not_found), None);
        assert_eq!(chart_result(&json!({ "chart": { "result": [] } })), None);
        assert_eq!(chart_result(&json!({ "chart": { "result": [null] } })), None);
        assert_eq!(chart_result(&json!({ "chart": null })), None);
        assert_eq!(chart_result(&json!({})), None);
        assert_eq!(chart_result(&json!([])), None);
    }

    #[test]
    fn detail_is_the_long_name_and_currency_from_chart_meta() {
        let detail = detail_of("VFIAX", &october_chart());
        assert_eq!(detail.ticker_symbol, "VFIAX");
        assert_eq!(detail.name, Some(json!("Vanguard 500 Index Admiral")));
        assert_eq!(detail.currency_name, Some(json!("USD")));
    }

    #[test]
    fn detail_falls_back_to_the_short_name_then_the_ticker_itself() {
        let short = json!({ "meta": { "currency": "EUR", "shortName": "Short", "longName": "" } });
        assert_eq!(detail_of("VFIAX", &short).name, Some(json!("Short")));
        assert_eq!(detail_of("VFIAX", &short).currency_name, Some(json!("EUR")));
        let bare = json!({
            "meta": { "instrumentType": "MUTUALFUND" },
            "timestamp": [ts(2026, 10, 6)],
            "indicators": { "quote": [{ "close": [720.06] }] },
        });
        assert_eq!(detail_of("VFIAX", &bare).name, Some(json!("VFIAX")));
        assert_eq!(detail_of("VFIAX", &bare).currency_name, Some(json!("USD")));
        assert_eq!(detail_of("VFIAX", &json!({})).name, Some(json!("VFIAX")));
    }

    #[test]
    fn close_price_asks_for_the_days_around_the_date() {
        let midnight = ts(2026, 10, 6);
        assert_eq!(
            close_price_query("2026-10-06"),
            format!("interval=1d&period1={}&period2={}", midnight - 86_400.0, midnight + 2.0 * 86_400.0)
        );
        assert_eq!(close_price_query("2026-10-06"), "interval=1d&period1=1791158400&period2=1791417600");
        assert_eq!(close_price_query("NaN-NaN-NaN"), "interval=1d&period1=NaN&period2=NaN");
    }

    #[test]
    fn close_is_the_bar_matching_the_date() {
        assert_eq!(close_on(&october_chart(), "2026-10-06"), Some(720.06));
        // A bar stamped during the day still belongs to its UTC date.
        let intraday = chart_ok(json!([ts(2026, 10, 6) + 14.5 * 3600.0]), json!([720.06]));
        assert_eq!(close_on(&intraday, "2026-10-06"), Some(720.06));
    }

    #[test]
    fn close_is_missing_when_no_bar_matches_the_date() {
        let chart = chart_ok(json!([ts(2026, 10, 1)]), json!([700.0]));
        assert_eq!(close_on(&chart, "2026-10-06"), None);
        assert_eq!(close_on(&json!({}), "2026-10-06"), None);
    }

    #[test]
    fn close_skips_null_closes() {
        let chart = chart_ok(json!([ts(2026, 10, 6)]), json!([null]));
        assert_eq!(close_on(&chart, "2026-10-06"), None);
    }

    #[test]
    fn latest_close_is_the_latest_bar_at_or_before_the_date() {
        // 2026-10-07 is a Wednesday; asked as of the Thursday after, its bar is the latest.
        assert_eq!(
            latest_close_on_or_before(&october_chart(), "2026-10-08"),
            Some(Close { price: 721.0, trading_date: "2026-10-07".into() })
        );
    }

    #[test]
    fn latest_close_skips_bars_after_the_date() {
        assert_eq!(
            latest_close_on_or_before(&october_chart(), "2026-10-06"),
            Some(Close { price: 720.06, trading_date: "2026-10-06".into() })
        );
    }

    #[test]
    fn latest_close_is_missing_when_every_bar_is_null() {
        let chart = chart_ok(json!([ts(2026, 10, 5), ts(2026, 10, 6), ts(2026, 10, 7)]), json!([null, null, null]));
        assert_eq!(latest_close_on_or_before(&chart, "2026-10-08"), None);
    }

    #[test]
    fn timestamps_are_seconds_read_in_utc() {
        assert_eq!(date_string_of_timestamp(ts(2026, 10, 6)), "2026-10-06");
        assert_eq!(date_string_of_timestamp(ts(2026, 10, 6) + 86_399.0), "2026-10-06");
        assert_eq!(date_string_of_timestamp(0.0), "1970-01-01");
        assert_eq!(date_string_of_timestamp(f64::NAN), "NaN-NaN-NaN");
    }

    #[test]
    fn misses_are_memoized_per_key() {
        let key = "detail:TEST-YAHOO-MEMO";
        assert!(!is_recent_miss(key));
        remember_miss(key);
        assert!(is_recent_miss(key));
        assert!(!is_recent_miss("price:TEST-YAHOO-MEMO:2026-10-06"));
        MISS_CACHE.lock().unwrap().insert(key.to_string(), JsDate::now_ms() - MISS_CACHE_TTL_MS);
        assert!(!is_recent_miss(key));
    }

    #[test]
    fn a_busy_gate_reads_as_rate_limited() {
        let shed = rate_limited_result("VFIAX");
        assert_eq!(shed.error.as_str(), "rate_limited");
        assert_eq!(shed.message, "Market data is busy right now; retry the lookup for VFIAX in a moment.");
    }

    #[tokio::test]
    async fn sheds_rather_than_parking_on_a_saturated_gate() {
        with_env(&[("YAHOO_RATE_LIMIT_PER_MIN", Some("1"))], async {
            YAHOO_QUEUE.reset();
            // The minute's one slot goes to something else.
            YAHOO_QUEUE.add(|| async {}, None).await.unwrap();
            let shed = fetch_chart("TEST-SHED", "interval=1d&range=5d", Some(10.0)).await.unwrap();
            assert_eq!(shed, Err(rate_limited_result("TEST-SHED")));
            // A lookup passes the refusal on as it is, naming the symbol Yahoo was asked for, and remembers nothing.
            let crypto = LookupOptions {
                max_wait_ms: Some(10.0),
                security_type: Some("cryptocurrency".into()),
                ..Default::default()
            };
            let detail = get_ticker_detail("TEST-SHED", &crypto).await.unwrap();
            assert_eq!(detail, Err(rate_limited_result("TEST-SHED-USD")));
            assert!(!is_recent_miss("detail:TEST-SHED-USD"));
            let latest = get_latest_close_price_on_or_before("TEST-SHED", "2026-10-08", &crypto).await.unwrap();
            assert_eq!(latest, Err(rate_limited_result("TEST-SHED-USD")));
            YAHOO_QUEUE.reset();
        })
        .await;
    }
}
