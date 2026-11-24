//! Polygon's market-data API, the primary source of prices:
//! `src/server/lib/polygon.ts`.
//! https://polygon.io/docs/stocks/getting-started
//!
//! How the TypeScript's shapes map here:
//!
//! - `PolygonResult<T>` is `Result<T, PolygonFailure>`. `{ success: true,
//!   data }` is `Ok(data)`; `{ success: false, error, message }` is
//!   `Err(PolygonFailure { error, message })`, `error` being a
//!   [`PolygonErrorKind`] whose `as_str()` is the TypeScript's string.
//! - Every options object (`{ maxWaitMs, securityType, lookbackDays }`) is a
//!   [`LookupOptions`]; a field left `None` is one the TypeScript leaves out.
//! - A `Date | string` argument is a [`DateOrString`].
//! - A function the TypeScript can throw from returns `anyhow::Result<…>`,
//!   the error carrying the JavaScript error's message; the others cannot
//!   fail outside their `PolygonResult`.
//! - A price is an `f64`. Polygon sends numbers; anything else in a price's
//!   place is NaN here, which `js::num` writes as `null`.
//! - `TickerDetail::name` and `currency_name` hold what the upstream sent,
//!   `None` standing for `undefined`, since callers pass them on as they are.
//!
//! The end of this file holds what the Bun runtime does around a `fetch`
//! (what a failed request, an unreadable body or malformed JSON is reported
//! as), which `yahoo.rs`, `daily_closes.rs` and `bls.rs` share: those messages
//! reach users inside failure messages, so both servers word them alike.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;
use std::sync::{LazyLock, Mutex, Once};
use std::time::Duration;

use crate::common::date::{get_date_string, get_date_time_string_of};
use crate::common::queue::{Queue, QueueWaitTimeoutError};
use crate::common::utils::get_random_id;
use crate::js::{self, encode_uri_component, js_slice_start, Json, JsDate, Obj};
use crate::server::alarm::http_client;
use crate::server::logger;

pub const POLYGON_HOST: &str = "https://api.polygon.io";

/// The API key, read on every call. Unset and empty both mean "not configured".
fn get_api_key() -> Option<String> {
    std::env::var("POLYGON_API_KEY").ok().filter(|key| !key.is_empty())
}

/// Warns at start-up when the API key is missing. The TypeScript does this
/// as the module loads; the start-up path calls it once.
pub fn initialize() {
    if get_api_key().is_none() {
        logger::warn(
            "POLYGON_API_KEY not set - stock price fetching will be disabled",
            Some(&crate::ctx! { "component": "polygon" }),
            None,
        );
    }
}

// ---------------------------------------------------------------------------
// Rate-limit gate
// ---------------------------------------------------------------------------
// Polygon's free tier caps at 5 calls/min. The monthly backfill can fan out to
// dozens of calls per security on first-seen accounts, so every outbound
// request goes through one shared `Queue` to avoid 429s and the retry backoff
// that follows. Cache hits never go through the queue: a warm read must not
// consume a slot.
//
// `POLYGON_RATE_LIMIT_PER_MIN` (default 5) caps the queue; 0 disables the
// gate (paid tiers, tests). It is read on every `add`.

const DEFAULT_RATE_LIMIT_PER_MIN: i64 = 5;

/// A per-minute cap as the gates read it from the environment: unset, empty,
/// not a number or negative is `default`; anything else rounds down.
pub fn rate_limit_per_min(raw: Option<&str>, default: i64) -> i64 {
    let Some(raw) = raw.filter(|raw| !raw.is_empty()) else { return default };
    let n = string_to_number(raw);
    if !n.is_finite() || n < 0.0 {
        return default;
    }
    n.floor() as i64
}

fn get_rate_limit_per_min() -> i64 {
    rate_limit_per_min(std::env::var("POLYGON_RATE_LIMIT_PER_MIN").ok().as_deref(), DEFAULT_RATE_LIMIT_PER_MIN)
}

pub static POLYGON_QUEUE: LazyLock<Queue> = LazyLock::new(|| Queue::new(get_rate_limit_per_min, 60_000.0));

/// Wait budget for a request a person is watching. The background backfill
/// and refresh passes have no deadline and keep queueing, but a form that has
/// been spinning for this long is better served by a retryable failure than
/// by a slot it would hold away from everyone else.
pub const FOREGROUND_QUEUE_WAIT_MS: f64 = 5_000.0;

/// The options the lookups take. `Default::default()` is the TypeScript's `{}`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LookupOptions {
    /// Overrides the queue's default unbounded wait. See [`FOREGROUND_QUEUE_WAIT_MS`].
    pub max_wait_ms: Option<f64>,
    /// The security's `type`; `"cryptocurrency"` moves the lookup to the crypto namespace.
    pub security_type: Option<String>,
    /// How far back the on-or-before lookups search; 7 days when `None`.
    pub lookback_days: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TickerDetail {
    pub ticker_symbol: String,
    /// `None` when the upstream answer carried none.
    pub name: Option<Json>,
    pub currency_name: Option<Json>,
}

impl TickerDetail {
    /// `{ ticker_symbol, name, currency_name }`, a missing field left out.
    pub fn to_json(&self) -> Json {
        let mut object = Obj::new();
        object.insert("ticker_symbol".into(), Json::String(self.ticker_symbol.clone()));
        if let Some(name) = &self.name {
            object.insert("name".into(), name.clone());
        }
        if let Some(currency_name) = &self.currency_name {
            object.insert("currency_name".into(), currency_name.clone());
        }
        Json::Object(object)
    }
}

/// A close and the trading day it belongs to (`YYYY-MM-DD`).
#[derive(Clone, Debug, PartialEq)]
pub struct Close {
    pub price: f64,
    pub trading_date: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolygonErrorKind {
    NoApiKey,
    ApiError,
    NoData,
    PlanLimit,
    RateLimited,
}

impl PolygonErrorKind {
    /// The TypeScript's `error` string.
    pub fn as_str(self) -> &'static str {
        match self {
            PolygonErrorKind::NoApiKey => "no_api_key",
            PolygonErrorKind::ApiError => "api_error",
            PolygonErrorKind::NoData => "no_data",
            PolygonErrorKind::PlanLimit => "plan_limit",
            PolygonErrorKind::RateLimited => "rate_limited",
        }
    }
}

/// The failed half of a `PolygonResult`.
#[derive(Clone, Debug, PartialEq)]
pub struct PolygonFailure {
    pub error: PolygonErrorKind,
    pub message: String,
}

impl PolygonFailure {
    pub fn new(error: PolygonErrorKind, message: impl Into<String>) -> Self {
        PolygonFailure { error, message: message.into() }
    }
}

/// Result type for Polygon (and Yahoo) calls.
pub type PolygonResult<T> = Result<T, PolygonFailure>;

/// A `Date | string` argument.
#[derive(Clone, Debug, PartialEq)]
pub enum DateOrString {
    Date(JsDate),
    String(String),
}

impl From<JsDate> for DateOrString {
    fn from(date: JsDate) -> Self {
        DateOrString::Date(date)
    }
}

impl From<&str> for DateOrString {
    fn from(text: &str) -> Self {
        DateOrString::String(text.to_string())
    }
}

impl From<String> for DateOrString {
    fn from(text: String) -> Self {
        DateOrString::String(text)
    }
}

impl DateOrString {
    /// The day as `YYYY-MM-DD`: a string's first ten characters, so no time
    /// zone can move it, or a date's local day.
    pub fn to_day(&self) -> String {
        match self {
            DateOrString::String(text) => js_slice_start(text, 10),
            DateOrString::Date(date) => get_date_string(*date),
        }
    }
}

/// Polygon namespaces crypto separately from US equities: a bare `BTC`
/// addresses the US-listed equity trading under that ticker, while Bitcoin
/// lives at `X:BTCUSD`. Map cryptocurrency securities onto the `X:{BASE}USD`
/// pair so their lookups never resolve to a same-ticker stock.
pub fn to_polygon_ticker(ticker_symbol: &str, security_type: Option<&str>) -> String {
    if security_type != Some("cryptocurrency") {
        return ticker_symbol.to_string();
    }
    if ticker_symbol.starts_with("X:") {
        return ticker_symbol.to_string();
    }
    format!("X:{ticker_symbol}USD")
}

const CACHE_TTL_MS: f64 = 60.0 * 60.0 * 1000.0; // 1 hour

struct CachedPrice {
    price: f64,
    fetched_at: f64,
}

/// Simple in-memory cache for price data.
/// Key format: `{polygonTicker}:{dateString}`, the resolved polygon ticker,
/// so an equity and a crypto sharing a ticker string cache apart.
static PRICE_CACHE: LazyLock<Mutex<HashMap<String, CachedPrice>>> = LazyLock::new(Default::default);

/// Lookups that came back empty, keyed by the same identity as the positive
/// cache. Without it a symbol Polygon does not know is the one lookup that
/// can never be served warm, so repeating it costs a rate slot every time
/// while a valid symbol costs one only once. The TTL is short because an
/// empty answer can turn into a real one within the day: a freshly listed
/// symbol, or today's close once the session settles.
static MISS_CACHE: LazyLock<Mutex<HashMap<String, f64>>> = LazyLock::new(Default::default);
const MISS_CACHE_TTL_MS: f64 = 5.0 * 60.0 * 1000.0; // 5 minutes

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

struct CachedDetail {
    detail: TickerDetail,
    fetched_at: f64,
}

/// Ticker details that resolved. The securities table is the durable cache,
/// but a caller can ask for a detail without ever saving one (the Add Holding
/// form checks a symbol with `save: false`), so without this a repeated check
/// of a symbol that *is* valid costs a rate slot every time.
static DETAIL_CACHE: LazyLock<Mutex<HashMap<String, CachedDetail>>> = LazyLock::new(Default::default);

static SWEEP: Once = Once::new();

/// Evicts stale cache entries, to prevent unbounded growth.
fn sweep_caches() {
    let now = JsDate::now_ms();
    PRICE_CACHE.lock().unwrap().retain(|_, entry| now - entry.fetched_at < CACHE_TTL_MS);
    MISS_CACHE.lock().unwrap().retain(|_, missed_at| now - *missed_at < MISS_CACHE_TTL_MS);
    DETAIL_CACHE.lock().unwrap().retain(|_, entry| now - entry.fetched_at < CACHE_TTL_MS);
}

/// Runs `sweep` every hour for as long as the process lives, the cadence of
/// the TypeScript's `setInterval(…, CACHE_TTL_MS).unref()`. Readers check
/// each entry's age themselves; the sweep only bounds memory. It starts with
/// the first entry cached, and like an unref'd timer it never holds the
/// process open.
pub(crate) fn start_cache_sweep(started: &'static Once, sweep: fn()) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
    started.call_once(|| {
        runtime.spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(CACHE_TTL_MS as u64));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                sweep();
            }
        });
    });
}

/// Neutralize anything that could end the path or open a query string: the
/// API key is appended after the ticker, so a raw `?` or `#` would truncate
/// the URL and send the call out unauthenticated. `:` is left alone: it is a
/// legal path character and carries Polygon's crypto namespace (`X:BTCUSD`).
pub fn encode_ticker(ticker: &str) -> String {
    encode_uri_component(ticker).replace("%3A", ":")
}

pub fn rate_limited_result(polygon_ticker: &str) -> PolygonFailure {
    PolygonFailure::new(
        PolygonErrorKind::RateLimited,
        format!("Market data is busy right now; retry the lookup for {polygon_ticker} in a moment."),
    )
}

fn no_api_key() -> PolygonFailure {
    PolygonFailure::new(PolygonErrorKind::NoApiKey, "Polygon API key not configured")
}

/// Polygon reports a refused call in the body rather than in the shape: a 429
/// or a plan rejection carries an error envelope and no `results`, which
/// absence alone cannot tell apart from a symbol that genuinely has no data.
/// Memoizing one of those answers "no such symbol" for the whole TTL, process
/// wide, for a symbol that exists. Returns the failure to surface, or `None`
/// when the empty answer is real and may be memoized: a 404 is how Polygon
/// says it does not carry the symbol, so it stays on that side.
///
/// `status` is the response's HTTP status and `json` its body. A `null` body
/// has no `status` to read: the TypeScript throws there, hence the `Err`.
pub fn upstream_refusal(status: u16, json: &Json, subject: &str) -> Result<Option<PolygonFailure>, Thrown> {
    if json.is_null() {
        return Err(Thrown::new("null is not an object (evaluating 'json.status')"));
    }
    let body_status = member(json, "status").and_then(Json::as_str);
    if body_status == Some("NOT_AUTHORIZED") {
        let message = match member(json, "message") {
            Some(Json::String(message)) => message.clone(),
            _ => format!("Polygon plan does not include data for {subject}"),
        };
        return Ok(Some(PolygonFailure::new(PolygonErrorKind::PlanLimit, message)));
    }
    if (is_ok(status) || status == 404) && body_status != Some("ERROR") {
        return Ok(None);
    }
    let message = match member(json, "error") {
        Some(Json::String(error)) => error.clone(),
        _ => format!("Polygon refused the lookup for {subject} (HTTP {status})"),
    };
    Ok(Some(PolygonFailure::new(PolygonErrorKind::ApiError, message)))
}

/// `response.ok`.
pub fn is_ok(status: u16) -> bool {
    (200..300).contains(&status)
}

/// Fetch with retry logic for transient failures: a network error or a 5xx
/// is tried again, `max_retries` more times, after `delay_ms` times the
/// attempt number. The TypeScript's defaults are 2 retries and 1000 ms.
pub async fn fetch_with_retry(url: &str, max_retries: u32, delay_ms: u64) -> Result<reqwest::Response, Thrown> {
    let mut last_error: Option<Thrown> = None;
    // A client that cannot be built stays that way: no retry would help.
    let client = http_client().map_err(|error| Thrown::new(error.to_string()))?;

    for attempt in 0..=max_retries {
        let backoff = Duration::from_millis(delay_ms * (attempt as u64 + 1));
        match client.get(url).send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                if is_ok(status) || status == 404 {
                    // 404 is "no data", not a transient error
                    return Ok(response);
                }
                // Retry on 5xx errors
                if status >= 500 {
                    last_error = Some(Thrown::new(format!("HTTP {status}")));
                    if attempt < max_retries {
                        tokio::time::sleep(backoff).await;
                        continue;
                    }
                }
                return Ok(response);
            }
            Err(error) => {
                last_error = Some(Thrown::new(fetch_error_message(&error)));
                if attempt < max_retries {
                    tokio::time::sleep(backoff).await;
                    continue;
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| Thrown::new("Fetch failed")))
}

/// `fetchWithRetry(url)` with the TypeScript's default arguments.
pub async fn fetch_with_default_retry(url: &str) -> Result<reqwest::Response, Thrown> {
    fetch_with_retry(url, 2, 1000).await
}

/// One gated request and its JSON body.
async fn get_json(url: &str, max_wait_ms: Option<f64>) -> Result<(u16, Json), Caught> {
    // The queue gate sits after the cache checks so warm reads don't consume a slot.
    let response = POLYGON_QUEUE.add(|| fetch_with_default_retry(url), max_wait_ms).await??;
    let status = response.status().as_u16();
    let json = response_json(response).await?;
    Ok((status, json))
}

fn close_price_url(polygon_ticker: &str, date_string: &str, api_key: &str) -> String {
    let (from, to) = (date_string, date_string);
    let ticker_parameter = format!("ticker/{}", encode_ticker(polygon_ticker));
    let range_parameter = format!("range/1/day/{from}/{to}");
    format!("{POLYGON_HOST}/v2/aggs/{ticker_parameter}/{range_parameter}?apiKey={api_key}")
}

/// `!json.results || json.results.length === 0`.
fn has_no_results(json: &Json) -> bool {
    match member(json, "results") {
        Some(Json::Array(results)) => results.is_empty(),
        // An object counts as empty only when it says so itself.
        Some(Json::Object(results)) => results.get("length").and_then(Json::as_f64) == Some(0.0),
        Some(results) => !js::truthy(results),
        None => true,
    }
}

/// `json.results[0].c` of an answer that has results.
fn first_close(json: &Json) -> Result<f64, Thrown> {
    let first = member(json, "results").and_then(element_at_start);
    match first.as_deref() {
        None => Err(Thrown::new("undefined is not an object (evaluating 'json.results[0].c')")),
        Some(Json::Null) => Err(Thrown::new("null is not an object (evaluating 'json.results[0].c')")),
        Some(first) => Ok(number_or_nan(member(first, "c"))),
    }
}

pub async fn get_close_price(ticker_symbol: &str, date: JsDate, options: &LookupOptions) -> PolygonResult<f64> {
    let Some(api_key) = get_api_key() else { return Err(no_api_key()) };

    let polygon_ticker = to_polygon_ticker(ticker_symbol, options.security_type.as_deref());
    let date_string = get_date_string(date);
    let cache_key = format!("{polygon_ticker}:{date_string}");

    // Check cache first
    if let Some(cached) = PRICE_CACHE.lock().unwrap().get(&cache_key) {
        if JsDate::now_ms() - cached.fetched_at < CACHE_TTL_MS {
            return Ok(cached.price);
        }
    }

    let miss_key = format!("price:{cache_key}");
    let no_data = || {
        PolygonFailure::new(
            PolygonErrorKind::NoData,
            format!("No price data available for {polygon_ticker} on {date_string}"),
        )
    };
    if is_recent_miss(&miss_key) {
        return Err(no_data());
    }

    let path = close_price_url(&polygon_ticker, &date_string, &api_key);

    let attempt = async {
        let (status, json) = get_json(&path, options.max_wait_ms).await?;

        if let Some(refusal) = upstream_refusal(status, &json, &polygon_ticker)? {
            return Ok(Err(refusal));
        }

        if has_no_results(&json) {
            remember_miss(&miss_key);
            return Ok(Err(no_data()));
        }

        let price = first_close(&json)?;

        // Cache successful result
        PRICE_CACHE.lock().unwrap().insert(cache_key.clone(), CachedPrice { price, fetched_at: JsDate::now_ms() });
        start_cache_sweep(&SWEEP, sweep_caches);

        Ok::<PolygonResult<f64>, Caught>(Ok(price))
    };
    match attempt.await {
        Ok(result) => result,
        Err(Caught::QueueWait) => Err(rate_limited_result(&polygon_ticker)),
        Err(Caught::Error(message)) => {
            logger::error(
                &format!("Polygon API error for {polygon_ticker}: {message}"),
                Some(&crate::ctx! { "component": "polygon" }),
                None,
            );
            Err(PolygonFailure::new(
                PolygonErrorKind::ApiError,
                format!("Failed to fetch price for {polygon_ticker}: {message}"),
            ))
        }
    }
}

fn ticker_detail_url(ticker_symbol: &str, api_key: &str) -> String {
    format!("{POLYGON_HOST}/v3/reference/tickers/{}?apiKey={api_key}", encode_ticker(ticker_symbol))
}

/// The detail a ticker answer carries in its `results`, if it has any.
fn detail_of(ticker_symbol: &str, json: &Json) -> Option<TickerDetail> {
    let results = member(json, "results").filter(|results| js::truthy(results))?;
    Some(TickerDetail {
        ticker_symbol: ticker_symbol.to_string(),
        name: member(results, "name").cloned(),
        currency_name: member(results, "currency_name").cloned(),
    })
}

/// Looks the ticker up as given: only `max_wait_ms` of the options applies.
pub async fn get_ticker_detail(ticker_symbol: &str, options: &LookupOptions) -> PolygonResult<TickerDetail> {
    let Some(api_key) = get_api_key() else { return Err(no_api_key()) };

    if let Some(cached) = DETAIL_CACHE.lock().unwrap().get(ticker_symbol) {
        if JsDate::now_ms() - cached.fetched_at < CACHE_TTL_MS {
            return Ok(cached.detail.clone());
        }
    }

    let miss_key = format!("detail:{ticker_symbol}");
    let no_data =
        || PolygonFailure::new(PolygonErrorKind::NoData, format!("No ticker details found for {ticker_symbol}"));
    if is_recent_miss(&miss_key) {
        return Err(no_data());
    }

    let path = ticker_detail_url(ticker_symbol, &api_key);

    let attempt = async {
        // Same queue as get_close_price: a backfill pass that uses both
        // endpoints stays under the per-minute cap across both methods.
        let (status, json) = get_json(&path, options.max_wait_ms).await?;

        if let Some(refusal) = upstream_refusal(status, &json, ticker_symbol)? {
            return Ok(Err(refusal));
        }

        let Some(detail) = detail_of(ticker_symbol, &json) else {
            remember_miss(&miss_key);
            return Ok(Err(no_data()));
        };
        DETAIL_CACHE
            .lock()
            .unwrap()
            .insert(ticker_symbol.to_string(), CachedDetail { detail: detail.clone(), fetched_at: JsDate::now_ms() });
        start_cache_sweep(&SWEEP, sweep_caches);

        Ok::<PolygonResult<TickerDetail>, Caught>(Ok(detail))
    };
    match attempt.await {
        Ok(result) => result,
        Err(Caught::QueueWait) => Err(rate_limited_result(ticker_symbol)),
        Err(Caught::Error(message)) => {
            logger::error(
                &format!("Polygon API error for ticker detail {ticker_symbol}: {message}"),
                Some(&crate::ctx! { "component": "polygon" }),
                None,
            );
            Err(PolygonFailure::new(
                PolygonErrorKind::ApiError,
                format!("Failed to fetch ticker details for {ticker_symbol}: {message}"),
            ))
        }
    }
}

fn daily_closes_url(polygon_ticker: &str, from: &str, to: &str, api_key: &str) -> String {
    format!(
        "{POLYGON_HOST}/v2/aggs/ticker/{}/range/1/day/{from}/{to}?apiKey={api_key}",
        encode_ticker(polygon_ticker)
    )
}

/// The UTC day of a bar's timestamp. Built from UTC components, so the
/// trading date is the same in every time zone.
fn trading_date_of(timestamp: Option<&Json>) -> String {
    let date = timestamp.map(JsDate::from_json).unwrap_or(JsDate::INVALID);
    if !date.is_valid() {
        return "NaN-NaN-NaN".to_string();
    }
    format!("{}-{:02}-{:02}", date.get_utc_full_year(), date.get_utc_month() + 1, date.get_utc_date())
}

/// The closes of a range answer's `results`, which the caller found non-empty.
fn closes_of_results(results: &Json) -> Result<Vec<Close>, Thrown> {
    let Json::Array(results) = results else { return Err(Thrown::new("results.map is not a function")) };
    results
        .iter()
        .map(|bar| match bar {
            Json::Null => Err(Thrown::new("Cannot destructure property 'c' from null or undefined value")),
            bar => Ok(Close { price: number_or_nan(member(bar, "c")), trading_date: trading_date_of(member(bar, "t")) }),
        })
        .collect()
}

/// Every daily close Polygon has in `[from, to]`, oldest first, one range
/// request. An empty range comes back as `no_data` and is remembered for a
/// while, so a repeated ask doesn't spend a request.
pub async fn get_daily_closes(
    ticker_symbol: &str,
    from: &str,
    to: &str,
    options: &LookupOptions,
) -> PolygonResult<Vec<Close>> {
    let Some(api_key) = get_api_key() else { return Err(no_api_key()) };

    let polygon_ticker = to_polygon_ticker(ticker_symbol, options.security_type.as_deref());

    let miss_key = format!("range:{polygon_ticker}:{from}:{to}");
    let no_data = || {
        PolygonFailure::new(PolygonErrorKind::NoData, format!("No price data for {polygon_ticker} in [{from}, {to}]"))
    };
    if is_recent_miss(&miss_key) {
        return Err(no_data());
    }

    let path = daily_closes_url(&polygon_ticker, from, to, &api_key);

    let attempt = async {
        let (status, json) = get_json(&path, options.max_wait_ms).await?;
        if let Some(refusal) = upstream_refusal(status, &json, &format!("{polygon_ticker} in [{from}, {to}]"))? {
            return Ok(Err(refusal));
        }
        if has_no_results(&json) {
            remember_miss(&miss_key);
            return Ok(Err(no_data()));
        }
        let closes = closes_of_results(member(&json, "results").unwrap_or(&Json::Null))?;
        Ok::<PolygonResult<Vec<Close>>, Caught>(Ok(closes))
    };
    match attempt.await {
        Ok(result) => result,
        Err(Caught::QueueWait) => Err(rate_limited_result(&polygon_ticker)),
        Err(Caught::Error(message)) => {
            logger::error(
                &format!("Polygon range fetch error for {polygon_ticker}: {message}"),
                Some(&crate::ctx! { "component": "polygon" }),
                None,
            );
            Err(PolygonFailure::new(PolygonErrorKind::ApiError, message))
        }
    }
}

/// The first day of a window of `lookback_days` ending at `to`, computed on
/// the calendar alone, so no local-time shift can move it. `to` that is not a
/// date is the TypeScript's `RangeError`.
fn lookback_start(to: &str, lookback_days: i64) -> Result<String, Thrown> {
    let anchor = JsDate::parse(&format!("{to}T12:00:00Z"));
    if !anchor.is_valid() {
        return Err(Thrown::new("Invalid Date"));
    }
    let start = JsDate::from_utc(
        anchor.get_utc_full_year(),
        anchor.get_utc_month(),
        anchor.get_utc_date() - lookback_days,
        12,
        0,
        0,
        0,
    );
    match start.to_iso_string() {
        Some(iso) => Ok(js_slice_start(&iso, 10)),
        None => Err(Thrown::new("Invalid Date")),
    }
}

/// Resolve the closest trading-day close price at or before `date`. Walks
/// Polygon's daily aggregates over a 7-day window ending at `date` and
/// returns the latest entry: that's the actual trading-day price for
/// non-trading-day inputs (weekends, holidays), so a Saturday resolves to
/// Friday's close instead of returning `no_data`.
///
/// `Err` only for a `date_or_string` that is not a date.
pub async fn get_latest_close_price_on_or_before(
    ticker_symbol: &str,
    date_or_string: impl Into<DateOrString>,
    options: &LookupOptions,
) -> anyhow::Result<PolygonResult<Close>> {
    let lookback_days = options.lookback_days.unwrap_or(7);

    // `to` and `from` come from the string alone, avoiding local-timezone
    // shifts. (A UTC-midnight date read in Pacific time is one day behind,
    // which silently turns a 2025-05-17 lookup into 2025-05-16.)
    let to = date_or_string.into().to_day();
    let from = lookback_start(&to, lookback_days)?;

    let closes = match get_daily_closes(ticker_symbol, &from, &to, options).await {
        Ok(closes) => closes,
        Err(failure) => return Ok(Err(failure)),
    };
    match closes.into_iter().next_back() {
        Some(latest) => Ok(Ok(latest)),
        // Unreachable: an empty range is `no_data` above.
        None => Ok(Err(PolygonFailure::new(PolygonErrorKind::NoData, format!("No price data for {ticker_symbol}")))),
    }
}

/// A security row for a symbol, from its close on `date` (yesterday when
/// `None`) and its ticker detail, or `None` when either lookup fails.
///
/// `Err` when the detail carries no currency to upper-case, where the
/// TypeScript throws.
pub async fn get_security_for_symbol(ticker_symbol: &str, date: Option<JsDate>) -> anyhow::Result<Option<Obj>> {
    let date = date.unwrap_or_else(|| JsDate::now().plus_ms(-24.0 * 60.0 * 60.0 * 1000.0));
    let options = LookupOptions::default();
    let (price_result, detail_result) =
        tokio::join!(get_close_price(ticker_symbol, date, &options), get_ticker_detail(ticker_symbol, &options));

    // Log errors but return nothing, for backward compatibility
    let context = crate::ctx! { "component": "polygon" };
    let price = match price_result {
        Ok(price) => price,
        Err(failure) => {
            logger::warn(&format!("getSecurityForSymbol: {}", failure.message), Some(&context), None);
            return Ok(None);
        }
    };
    let detail = match detail_result {
        Ok(detail) => detail,
        Err(failure) => {
            logger::warn(&format!("getSecurityForSymbol: {}", failure.message), Some(&context), None);
            return Ok(None);
        }
    };

    let iso_currency_code = match &detail.currency_name {
        Some(Json::String(currency_name)) => currency_name.to_uppercase(),
        None => anyhow::bail!("undefined is not an object (evaluating 'currency_name.toUpperCase')"),
        Some(Json::Null) => anyhow::bail!("null is not an object (evaluating 'currency_name.toUpperCase')"),
        Some(_) => anyhow::bail!(
            "currency_name.toUpperCase is not a function. (In 'currency_name.toUpperCase()', 'currency_name.toUpperCase' is undefined)"
        ),
    };

    let mut security = Obj::new();
    security.insert("security_id".into(), Json::String(get_random_id()));
    security.insert("ticker_symbol".into(), Json::String(ticker_symbol.to_string()));
    if let Some(name) = detail.name {
        security.insert("name".into(), name);
    }
    security.insert("iso_currency_code".into(), Json::String(iso_currency_code));
    security.insert("close_price".into(), js::num(price));
    security.insert("close_price_as_of".into(), Json::String(get_date_time_string_of(date)));
    for key in [
        "isin",
        "cusip",
        "sedol",
        "institution_security_id",
        "institution_id",
        "proxy_security_id",
        "is_cash_equivalent",
        "type",
        "update_datetime",
        "unofficial_currency_code",
        "market_identifier_code",
        "sector",
        "industry",
        "option_contract",
        "fixed_income",
    ] {
        security.insert(key.into(), Json::Null);
    }
    Ok(Some(security))
}

/// Clear the price cache, the ticker-detail cache and the empty-result memo
/// (useful for testing)
pub fn clear_price_cache() {
    PRICE_CACHE.lock().unwrap().clear();
    DETAIL_CACHE.lock().unwrap().clear();
    MISS_CACHE.lock().unwrap().clear();
}

// ---------------------------------------------------------------------------
// What the Bun runtime does around a `fetch`
// ---------------------------------------------------------------------------

/// An error the TypeScript throws, as its JavaScript `message`.
#[derive(Clone, Debug, PartialEq)]
pub struct Thrown(pub String);

impl Thrown {
    pub fn new(message: impl Into<String>) -> Self {
        Thrown(message.into())
    }
}

impl fmt::Display for Thrown {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Thrown {}

/// What the `catch` around an upstream call receives.
#[derive(Clone, Debug, PartialEq)]
pub enum Caught {
    /// A `QueueWaitTimeoutError`: the rate gate had no slot within the wait budget.
    QueueWait,
    /// Any other error, as its message.
    Error(String),
}

impl From<QueueWaitTimeoutError> for Caught {
    fn from(_: QueueWaitTimeoutError) -> Self {
        Caught::QueueWait
    }
}

impl From<Thrown> for Caught {
    fn from(thrown: Thrown) -> Self {
        Caught::Error(thrown.0)
    }
}

/// What the HTTP client reported for a request that got no response.
#[derive(Debug, Default)]
struct FetchFailure {
    /// The connection was refused.
    refused: bool,
    /// The connection ended before a response did.
    closed: bool,
    /// The host the request was for.
    host: Option<String>,
    /// The error's causes, outermost first. The request's own line, which
    /// carries the URL and with it the API key, is not among them.
    causes: Vec<String>,
}

/// The message of the error Bun's `fetch` rejects with for a request that got
/// no response (or whose body broke off), for the failures both runtimes
/// were observed in: a refused or dropped connection, a host that does not
/// resolve, a peer that does not speak TLS, a certificate nobody vouches for.
/// Anything else is reported in the HTTP client's own words.
pub fn fetch_error_message(error: &reqwest::Error) -> String {
    use std::error::Error as _;
    use std::io::ErrorKind;

    let mut failure =
        FetchFailure { host: error.url().and_then(|url| url.host_str()).map(str::to_string), ..Default::default() };
    let mut source = error.source();
    while let Some(cause) = source {
        failure.causes.push(cause.to_string());
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            match io.kind() {
                ErrorKind::ConnectionRefused => failure.refused = true,
                ErrorKind::ConnectionReset
                | ErrorKind::ConnectionAborted
                | ErrorKind::BrokenPipe
                | ErrorKind::UnexpectedEof => failure.closed = true,
                _ => {}
            }
        }
        if let Some(hyper) = cause.downcast_ref::<hyper::Error>() {
            if hyper.is_incomplete_message() || hyper.is_closed() || hyper.is_canceled() {
                failure.closed = true;
            }
        }
        source = cause.source();
    }
    if failure.causes.is_empty() {
        // An error with no cause is the client's own; its text would carry the URL.
        let kind = if error.is_builder() {
            "the request could not be built"
        } else if error.is_body() || error.is_decode() {
            "the response body could not be read"
        } else {
            "the request could not be sent"
        };
        failure.causes.push(kind.to_string());
    }
    describe_fetch_failure(&failure)
}

fn describe_fetch_failure(failure: &FetchFailure) -> String {
    let said = |words: &str| failure.causes.iter().any(|cause| cause.to_lowercase().contains(words));
    if failure.refused {
        return "ECONNREFUSED: Unable to connect. Is the computer able to access the url?".to_string();
    }
    if let (true, Some(host)) = (said("dns error"), &failure.host) {
        return format!("getaddrinfo ENOTFOUND {host}");
    }
    if said("unknownissuer") {
        return "unable to verify the first certificate".to_string();
    }
    if said("received corrupt message") {
        return "EPROTO: The TLS handshake failed. Does the server speak TLS on this port?".to_string();
    }
    if failure.closed || said("unexpected end of file") || said("handshake eof") {
        return "ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()".to_string();
    }
    failure.causes.last().cloned().unwrap_or_else(|| "Fetch failed".to_string())
}

/// Statuses whose responses never carry a body.
fn is_null_body_status(status: u16) -> bool {
    matches!(status, 101 | 103 | 204 | 205 | 304)
}

/// `await response.json()`: the body parsed as JSON, or the message of what
/// that throws. An empty body is `null` rather than an error, except on a
/// status that never carries one: that is how Bun reads them.
pub async fn response_json(response: reqwest::Response) -> Result<Json, Thrown> {
    let status = response.status().as_u16();
    let bytes = response.bytes().await.map_err(|error| Thrown::new(fetch_error_message(&error)))?;
    parse_json_body(status, &bytes)
}

/// [`response_json`] for a body already read.
pub fn parse_json_body(status: u16, bytes: &[u8]) -> Result<Json, Thrown> {
    if bytes.is_empty() {
        return if is_null_body_status(status) {
            Err(Thrown::new("Unexpected end of JSON input"))
        } else {
            Ok(Json::Null)
        };
    }
    // Decoded as UTF-8, a byte-order mark dropped, as `Body.json()` does.
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    js::json_parse(text).ok_or_else(|| Thrown::new(json_parse_error(text)))
}

/// The message of the `SyntaxError` JavaScriptCore's `JSON.parse` throws for
/// `text`. Bodies that are not JSON (an HTML error page, a truncated answer)
/// end up in failure messages users see, so the wording follows the engine's
/// parser token for token. For text that parser accepts, this is its generic
/// message.
pub fn json_parse_error(text: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut lexer = JsonLexer { units: &units, at: 0, token: JsonToken::Eof, error: None };
    lexer.next();
    let parsed = parse_json_value(&mut lexer);
    let reason = match (lexer.error.take(), parsed) {
        (Some(lexed), _) => lexed,
        (None, Err(reason)) => reason,
        (None, Ok(())) => "Unable to parse JSON string".to_string(),
    };
    format!("JSON Parse error: {reason}")
}

#[derive(Clone, Debug, PartialEq)]
enum JsonToken {
    LBracket,
    RBracket,
    LParen,
    RParen,
    LBrace,
    RBrace,
    String,
    Identifier(String),
    Number,
    Null,
    True,
    False,
    Colon,
    Comma,
    Dot,
    Assign,
    Semi,
    Eof,
    Error,
}

struct JsonLexer<'a> {
    units: &'a [u16],
    at: usize,
    token: JsonToken,
    /// The lexer's own complaint, which wins over the parser's.
    error: Option<String>,
}

/// One UTF-16 code unit as it prints inside a message.
fn unit_text(unit: u16) -> String {
    String::from_utf16_lossy(&[unit])
}

impl JsonLexer<'_> {
    fn peek(&self, offset: usize) -> Option<u16> {
        self.units.get(self.at + offset).copied()
    }

    fn is(&self, offset: usize, ch: char) -> bool {
        self.peek(offset) == Some(ch as u16)
    }

    fn is_digit(&self, offset: usize) -> bool {
        matches!(self.peek(offset), Some(unit) if (b'0' as u16..=b'9' as u16).contains(&unit))
    }

    fn fail(&mut self, message: String) -> JsonToken {
        self.error = Some(message);
        JsonToken::Error
    }

    fn next(&mut self) -> JsonToken {
        self.token = self.lex();
        self.token.clone()
    }

    fn lex(&mut self) -> JsonToken {
        while matches!(self.peek(0), Some(0x20 | 0x09 | 0x0a | 0x0d)) {
            self.at += 1;
        }
        let Some(unit) = self.peek(0) else { return JsonToken::Eof };
        let simple = match char::from_u32(unit as u32) {
            Some('[') => Some(JsonToken::LBracket),
            Some(']') => Some(JsonToken::RBracket),
            Some('(') => Some(JsonToken::LParen),
            Some(')') => Some(JsonToken::RParen),
            Some('{') => Some(JsonToken::LBrace),
            Some('}') => Some(JsonToken::RBrace),
            Some(',') => Some(JsonToken::Comma),
            Some(':') => Some(JsonToken::Colon),
            Some('.') => Some(JsonToken::Dot),
            Some('=') => Some(JsonToken::Assign),
            Some(';') => Some(JsonToken::Semi),
            _ => None,
        };
        if let Some(token) = simple {
            self.at += 1;
            return token;
        }
        match char::from_u32(unit as u32) {
            Some('"') => self.lex_string(),
            Some('\'') => self.fail("Single quotes (') are not allowed in JSON".to_string()),
            Some('0'..='9' | '-') => self.lex_number(),
            Some('a'..='z' | 'A'..='Z' | '_' | '$') => {
                for (word, token) in [("true", JsonToken::True), ("false", JsonToken::False), ("null", JsonToken::Null)] {
                    if word.chars().enumerate().all(|(offset, ch)| self.is(offset, ch)) {
                        self.at += word.len();
                        return token;
                    }
                }
                let start = self.at;
                while matches!(self.peek(0), Some(unit) if is_identifier_unit(unit)) {
                    self.at += 1;
                }
                JsonToken::Identifier(String::from_utf16_lossy(self.units.get(start..self.at).unwrap_or_default()))
            }
            _ => self.fail(format!("Unrecognized token '{}'", unit_text(unit))),
        }
    }

    fn lex_string(&mut self) -> JsonToken {
        self.at += 1;
        loop {
            let run_start = self.at;
            while matches!(self.peek(0), Some(unit) if unit >= 0x20 && unit != b'\\' as u16 && unit != b'"' as u16) {
                self.at += 1;
            }
            if self.is(0, '\\') {
                self.at += 1;
                let Some(escaped) = self.peek(0) else { return self.fail("Unterminated string".to_string()) };
                match char::from_u32(escaped as u32) {
                    Some('"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't') => self.at += 1,
                    Some('u') => {
                        // The `u` and the four units after it.
                        let Some(escape) = self.units.get(self.at..self.at + 5) else {
                            return self.fail("\\u must be followed by 4 hex digits".to_string());
                        };
                        let is_hex = |unit: &u16| char::from_u32(*unit as u32).map(|ch| ch.is_ascii_hexdigit()).unwrap_or(false);
                        if !escape.iter().skip(1).all(is_hex) {
                            return self.fail(format!(
                                "\"\\{}\" is not a valid unicode escape",
                                String::from_utf16_lossy(escape)
                            ));
                        }
                        self.at += 5;
                    }
                    _ => return self.fail(format!("Invalid escape character {}", unit_text(escaped))),
                }
            }
            let advanced = self.at != run_start;
            if !(advanced && self.at < self.units.len() && !self.is(0, '"')) {
                break;
            }
        }
        if !self.is(0, '"') {
            return self.fail("Unterminated string".to_string());
        }
        self.at += 1;
        JsonToken::String
    }

    fn lex_number(&mut self) -> JsonToken {
        if self.is(0, '-') {
            self.at += 1;
        }
        if self.is(0, '0') {
            self.at += 1;
        } else if self.is_digit(0) {
            while self.is_digit(0) {
                self.at += 1;
            }
        } else {
            return self.fail("Invalid number".to_string());
        }
        if self.is(0, '.') {
            self.at += 1;
            if !self.is_digit(0) {
                return self.fail("Invalid digits after decimal point".to_string());
            }
            while self.is_digit(0) {
                self.at += 1;
            }
        }
        if self.is(0, 'e') || self.is(0, 'E') {
            // An exponent with no digits is not part of the number.
            let sign = usize::from(self.is(1, '+') || self.is(1, '-'));
            if self.is_digit(1 + sign) {
                self.at += 1 + sign;
                while self.is_digit(0) {
                    self.at += 1;
                }
            }
        }
        JsonToken::Number
    }
}

fn is_identifier_unit(unit: u16) -> bool {
    matches!(char::from_u32(unit as u32), Some('a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '$' | '\u{200c}' | '\u{200d}'))
}

const EXPECTED_COLON: &str = "Expected ':' before value in object property definition";

/// Parses one value from the lexer's current token. `Err` is the parser's
/// complaint; `Ok` leaves the lexer on the token after the value, which the
/// parser has no words for when it is not the end of the text.
fn parse_json_value(lexer: &mut JsonLexer<'_>) -> Result<(), String> {
    enum Open {
        Array,
        Object,
    }
    let mut open: Vec<Open> = Vec::new();
    loop {
        // A value starts at the current token.
        match lexer.token.clone() {
            JsonToken::LBracket => {
                if lexer.next() != JsonToken::RBracket {
                    open.push(Open::Array);
                    continue;
                }
                lexer.next();
            }
            JsonToken::LBrace => match lexer.next() {
                JsonToken::String => {
                    if lexer.next() != JsonToken::Colon {
                        return Err(EXPECTED_COLON.to_string());
                    }
                    lexer.next();
                    open.push(Open::Object);
                    continue;
                }
                JsonToken::RBrace => {
                    lexer.next();
                }
                _ => return Err("Expected '}'".to_string()),
            },
            JsonToken::String | JsonToken::Number | JsonToken::Null | JsonToken::True | JsonToken::False => {
                lexer.next();
            }
            JsonToken::RBracket => return Err("Unexpected token ']'".to_string()),
            JsonToken::RBrace => return Err("Unexpected token '}'".to_string()),
            JsonToken::Identifier(name) => return Err(format!("Unexpected identifier \"{name}\"")),
            JsonToken::Colon => return Err("Unexpected token ':'".to_string()),
            JsonToken::LParen => return Err("Unexpected token '('".to_string()),
            JsonToken::RParen => return Err("Unexpected token ')'".to_string()),
            JsonToken::Comma => return Err("Unexpected token ','".to_string()),
            JsonToken::Dot => return Err("Unexpected token '.'".to_string()),
            JsonToken::Assign => return Err("Unexpected token '='".to_string()),
            JsonToken::Semi => return Err("Unexpected token ';'".to_string()),
            JsonToken::Eof => return Err("Unexpected EOF".to_string()),
            JsonToken::Error => return Err("Could not parse value expression".to_string()),
        }
        // A value ended: close what it completes, or move to the next member.
        loop {
            match open.last() {
                None => return Ok(()),
                Some(Open::Array) => {
                    if lexer.token == JsonToken::Comma {
                        if lexer.next() == JsonToken::RBracket {
                            return Err("Unexpected comma at the end of array expression".to_string());
                        }
                        break;
                    }
                    if lexer.token != JsonToken::RBracket {
                        return Err("Expected ']'".to_string());
                    }
                }
                Some(Open::Object) => {
                    if lexer.token == JsonToken::Comma {
                        if lexer.next() != JsonToken::String {
                            return Err("Property name must be a string literal".to_string());
                        }
                        if lexer.next() != JsonToken::Colon {
                            return Err(EXPECTED_COLON.to_string());
                        }
                        lexer.next();
                        break;
                    }
                    if lexer.token != JsonToken::RBrace {
                        return Err("Expected '}'".to_string());
                    }
                }
            }
            lexer.next();
            open.pop();
        }
    }
}

// ---------------------------------------------------------------------------
// Reading upstream JSON the way the TypeScript's property accesses do
// ---------------------------------------------------------------------------

/// `value.key`: a property of an object; `undefined` (`None`) on anything else.
pub(crate) fn member<'a>(value: &'a Json, key: &str) -> Option<&'a Json> {
    value.as_object().and_then(|object| object.get(key))
}

/// `value?.key`, chained from a value that may be missing.
pub(crate) fn optional_member<'a>(value: Option<&'a Json>, key: &str) -> Option<&'a Json> {
    value.and_then(|value| member(value, key))
}

/// `value[index]`: an array's element, a string's character, or an object's
/// property of that name.
pub(crate) fn element_at(value: &Json, index: usize) -> Option<Cow<'_, Json>> {
    match value {
        Json::Array(items) => items.get(index).map(Cow::Borrowed),
        Json::Object(object) => object.get(&index.to_string()).map(Cow::Borrowed),
        Json::String(text) => {
            text.encode_utf16().nth(index).map(|unit| Cow::Owned(Json::String(String::from_utf16_lossy(&[unit]))))
        }
        _ => None,
    }
}

fn element_at_start(value: &Json) -> Option<Cow<'_, Json>> {
    element_at(value, 0)
}

/// `value ?? fallback` for a value read with the helpers above.
pub(crate) fn non_nullish(value: Option<&Json>) -> Option<&Json> {
    value.filter(|value| !value.is_null())
}

/// A JSON number, or NaN for anything that is not one.
pub(crate) fn number_or_nan(value: Option<&Json>) -> f64 {
    match value {
        Some(Json::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

/// `Number(text)`, including the binary and octal prefixes.
pub(crate) fn string_to_number(text: &str) -> f64 {
    let trimmed = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    for (prefix, radix) in [("0b", 2), ("0B", 2), ("0o", 8), ("0O", 8)] {
        if let Some(digits) = trimmed.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).map(|n| n as f64).unwrap_or(f64::NAN);
        }
    }
    js::to_number(trimmed)
}

/// `Number(value)` for a JSON value; `None` is `undefined`.
pub(crate) fn to_number(value: Option<&Json>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Json::Null) => 0.0,
        Some(Json::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Json::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Json::String(text)) => string_to_number(text),
        Some(array @ Json::Array(_)) => string_to_number(&js::to_js_string(array)),
        Some(Json::Object(_)) => f64::NAN,
    }
}

/// `a < b`, `a > b` between two strings: by UTF-16 code unit, as JavaScript orders them.
pub(crate) fn compare_strings(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    /// Held by every test that reads or changes the market-data environment
    /// variables, which the process shares.
    pub(crate) static ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// Sets (`Some`) or removes (`None`) environment variables, returning what was there.
    pub(crate) fn swap_env(vars: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
        let before = vars.iter().map(|(name, _)| (name.to_string(), std::env::var(name).ok())).collect();
        for (name, value) in vars {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        before
    }

    pub(crate) fn restore_env(before: Vec<(String, Option<String>)>) {
        for (name, value) in before {
            match value {
                Some(value) => std::env::set_var(&name, value),
                None => std::env::remove_var(&name),
            }
        }
    }

    /// Runs `body` with environment variables set or removed, then puts the old values back.
    pub(crate) async fn with_env<T>(vars: &[(&str, Option<&str>)], body: impl std::future::Future<Output = T>) -> T {
        let _guard = ENV.lock().await;
        let before = swap_env(vars);
        let result = body.await;
        restore_env(before);
        result
    }

    /// [`with_env`] for a test that is not async.
    pub(crate) fn with_env_sync<T>(vars: &[(&str, Option<&str>)], body: impl FnOnce() -> T) -> T {
        let _guard = ENV.blocking_lock();
        let before = swap_env(vars);
        let result = body();
        restore_env(before);
        result
    }

    #[tokio::test]
    async fn every_lookup_answers_no_api_key_when_the_key_is_not_set() {
        with_env(&[("POLYGON_API_KEY", Some(""))], async {
            let options = LookupOptions::default();
            let price = get_close_price("AAPL", JsDate::parse("2024-01-15"), &options).await;
            assert_eq!(price, Err(PolygonFailure::new(PolygonErrorKind::NoApiKey, "Polygon API key not configured")));
            let detail = get_ticker_detail("AAPL", &options).await;
            assert_eq!(detail.unwrap_err().error, PolygonErrorKind::NoApiKey);
            let range = get_daily_closes("AAPL", "2024-01-08", "2024-01-15", &options).await;
            assert_eq!(range.unwrap_err().error, PolygonErrorKind::NoApiKey);
            let latest = get_latest_close_price_on_or_before("AAPL", JsDate::parse("2024-01-15"), &options).await;
            assert_eq!(latest.unwrap().unwrap_err().error.as_str(), "no_api_key");
        })
        .await;
        with_env(&[("POLYGON_API_KEY", None)], async {
            let price = get_close_price("AAPL", JsDate::parse("2024-01-15"), &LookupOptions::default()).await;
            assert_eq!(price.unwrap_err().error, PolygonErrorKind::NoApiKey);
        })
        .await;
    }

    #[tokio::test]
    async fn sheds_with_rate_limited_rather_than_parking_on_a_saturated_gate() {
        with_env(&[("POLYGON_API_KEY", Some("test-key")), ("POLYGON_RATE_LIMIT_PER_MIN", Some("1"))], async {
            POLYGON_QUEUE.reset();
            // The minute's one slot goes to something else.
            POLYGON_QUEUE.add(|| async {}, None).await.unwrap();
            let waiting = LookupOptions { max_wait_ms: Some(10.0), ..Default::default() };
            let shed = get_close_price("TEST-SHED", JsDate::parse("2024-01-15"), &waiting).await;
            assert_eq!(shed, Err(rate_limited_result("TEST-SHED")));
            let crypto = LookupOptions { security_type: Some("cryptocurrency".into()), ..waiting.clone() };
            let shed = get_daily_closes("TEST-SHED", "2024-01-08", "2024-01-15", &crypto).await;
            assert_eq!(shed, Err(rate_limited_result("X:TEST-SHEDUSD")));
            assert_eq!(get_ticker_detail("TEST-SHED", &waiting).await, Err(rate_limited_result("TEST-SHED")));
            // A shed lookup is not remembered as empty.
            assert!(!is_recent_miss("detail:TEST-SHED"));
            POLYGON_QUEUE.reset();
        })
        .await;
    }

    #[test]
    fn ticker_details_come_from_the_answers_results() {
        let detail = detail_of("AAPL", &json!({ "results": { "name": "Apple Inc.", "currency_name": "usd" } })).unwrap();
        assert_eq!(detail.ticker_symbol, "AAPL");
        assert_eq!(detail.name, Some(json!("Apple Inc.")));
        assert_eq!(detail.currency_name, Some(json!("usd")));
        assert_eq!(detail.to_json(), json!({ "ticker_symbol": "AAPL", "name": "Apple Inc.", "currency_name": "usd" }));
        // No results is no detail; results without a field leave it out.
        assert_eq!(detail_of("INVALID", &json!({})), None);
        assert_eq!(detail_of("INVALID", &json!({ "results": null })), None);
        assert_eq!(detail_of("ODD", &json!({ "results": { "name": 5 } })).unwrap().to_json(), json!({ "ticker_symbol": "ODD", "name": 5 }));
    }

    #[test]
    fn rate_limits_parse_like_number() {
        assert_eq!(rate_limit_per_min(None, 5), 5);
        assert_eq!(rate_limit_per_min(Some(""), 5), 5);
        assert_eq!(rate_limit_per_min(Some("0"), 5), 0);
        assert_eq!(rate_limit_per_min(Some("2"), 5), 2);
        assert_eq!(rate_limit_per_min(Some(" 12 "), 5), 12);
        assert_eq!(rate_limit_per_min(Some("7.9"), 5), 7);
        assert_eq!(rate_limit_per_min(Some("1e2"), 5), 100);
        assert_eq!(rate_limit_per_min(Some("0x10"), 5), 16);
        assert_eq!(rate_limit_per_min(Some("0b11"), 5), 3);
        assert_eq!(rate_limit_per_min(Some("-1"), 5), 5);
        assert_eq!(rate_limit_per_min(Some("-0"), 5), 0);
        assert_eq!(rate_limit_per_min(Some("abc"), 5), 5);
        assert_eq!(rate_limit_per_min(Some("5 per minute"), 30), 30);
        assert_eq!(rate_limit_per_min(Some("Infinity"), 5), 5);
        assert_eq!(rate_limit_per_min(Some("NaN"), 5), 5);
        // Whitespace alone is `Number(" ")`, zero: the gate is off.
        assert_eq!(rate_limit_per_min(Some(" "), 5), 0);
    }

    #[test]
    fn crypto_tickers_move_to_the_crypto_namespace() {
        assert_eq!(to_polygon_ticker("BTC", Some("cryptocurrency")), "X:BTCUSD");
        // Non-crypto types keep the bare ticker.
        assert_eq!(to_polygon_ticker("BTC", Some("equity")), "BTC");
        assert_eq!(to_polygon_ticker("VOO", None), "VOO");
        // A ticker already in the crypto namespace is not prefixed twice.
        assert_eq!(to_polygon_ticker("X:ETHUSD", Some("cryptocurrency")), "X:ETHUSD");
        // The caches key on the resolved ticker, so a crypto lookup is never
        // satisfied by the equity entry for the same ticker string.
        assert_ne!(to_polygon_ticker("BTC", Some("cryptocurrency")), to_polygon_ticker("BTC", Some("equity")));
    }

    #[test]
    fn close_price_requests_one_day_of_the_resolved_ticker() {
        let crypto = close_price_url(&to_polygon_ticker("BTC", Some("cryptocurrency")), "2024-01-15", "test-key");
        assert_eq!(
            crypto,
            "https://api.polygon.io/v2/aggs/ticker/X:BTCUSD/range/1/day/2024-01-15/2024-01-15?apiKey=test-key"
        );
        let equity = close_price_url(&to_polygon_ticker("BTC", Some("equity")), "2024-01-15", "test-key");
        assert!(equity.contains("/v2/aggs/ticker/BTC/range/1/day/"));
        let range = daily_closes_url(&to_polygon_ticker("BTC", Some("cryptocurrency")), "2024-01-08", "2024-01-15", "k");
        assert_eq!(range, "https://api.polygon.io/v2/aggs/ticker/X:BTCUSD/range/1/day/2024-01-08/2024-01-15?apiKey=k");
    }

    #[test]
    fn ticker_encoding_keeps_the_api_key_on_its_own_query_parameter() {
        assert_eq!(
            ticker_detail_url("AAPL?apiKey=stolen", "test-key"),
            "https://api.polygon.io/v3/reference/tickers/AAPL%3FapiKey%3Dstolen?apiKey=test-key"
        );
        // The crypto namespace colon stays intact.
        assert!(ticker_detail_url("X:BTCUSD", "test-key").contains("/v3/reference/tickers/X:BTCUSD?apiKey="));
        assert_eq!(encode_ticker("BRK.B"), "BRK.B");
        assert_eq!(encode_ticker("A/B#C D"), "A%2FB%23C%20D");
    }

    #[test]
    fn the_lookback_window_ends_at_the_given_date() {
        assert_eq!(lookback_start("2024-01-15", 3).unwrap(), "2024-01-12");
        assert_eq!(lookback_start("2024-01-15", 7).unwrap(), "2024-01-08");
        assert_eq!(lookback_start("2024-03-02", 7).unwrap(), "2024-02-24");
        assert_eq!(lookback_start("2024-01-03", 7).unwrap(), "2023-12-27");
        assert_eq!(lookback_start("not a date", 7), Err(Thrown::new("Invalid Date")));
        // A string keeps its day whatever the time zone; a time part is cut off.
        assert_eq!(DateOrString::from("2025-05-17T00:00:00Z").to_day(), "2025-05-17");
        assert_eq!(DateOrString::from(JsDate::from_local_ymd(2024, 0, 13)).to_day(), "2024-01-13");
    }

    #[test]
    fn range_results_keep_their_utc_trading_date() {
        let thursday = JsDate::from_utc(2024, 0, 11, 0, 0, 0, 0).get_time();
        let friday = JsDate::from_utc(2024, 0, 12, 0, 0, 0, 0).get_time();
        let closes = closes_of_results(&json!([{ "c": 184, "t": thursday }, { "c": 185, "t": friday }])).unwrap();
        // The latest entry of the range is the last one.
        assert_eq!(closes.last(), Some(&Close { price: 185.0, trading_date: "2024-01-12".into() }));
        assert_eq!(closes[0], Close { price: 184.0, trading_date: "2024-01-11".into() });
        // Polygon stamps a daily bar at the session's start in New York.
        let session = JsDate::from_utc(2024, 0, 15, 5, 0, 0, 0).get_time();
        assert_eq!(closes_of_results(&json!([{ "c": 472.5, "t": session }])).unwrap()[0].trading_date, "2024-01-15");
        // A bar without a usable timestamp or close is carried as JavaScript would.
        let odd = closes_of_results(&json!([{ "c": "x" }])).unwrap();
        assert_eq!(odd[0].trading_date, "NaN-NaN-NaN");
        assert!(odd[0].price.is_nan());
        assert!(closes_of_results(&json!("abc")).is_err());
    }

    #[test]
    fn an_answer_without_results_is_empty() {
        assert!(has_no_results(&json!({})));
        assert!(has_no_results(&json!({ "results": [] })));
        assert!(has_no_results(&json!({ "results": null })));
        assert!(has_no_results(&json!({ "status": "NOT_FOUND" })));
        assert!(has_no_results(&json!([1, 2])));
        assert!(!has_no_results(&json!({ "results": [{ "c": 185.5 }] })));
        assert_eq!(first_close(&json!({ "results": [{ "c": 185.5 }] })), Ok(185.5));
        assert!(first_close(&json!({ "results": [{}] })).unwrap().is_nan());
        assert_eq!(
            first_close(&json!({ "results": [null] })),
            Err(Thrown::new("null is not an object (evaluating 'json.results[0].c')"))
        );
        assert_eq!(
            first_close(&json!({ "results": {} })),
            Err(Thrown::new("undefined is not an object (evaluating 'json.results[0].c')"))
        );
    }

    #[test]
    fn a_plan_rejection_is_plan_limit() {
        let refusal = upstream_refusal(
            200,
            &json!({ "status": "NOT_AUTHORIZED", "message": "Your plan doesn't include this data timeframe." }),
            "VOO",
        );
        assert_eq!(
            refusal,
            Ok(Some(PolygonFailure::new(PolygonErrorKind::PlanLimit, "Your plan doesn't include this data timeframe.")))
        );
        // Whatever the HTTP status, and with a message of its own when Polygon gives none.
        assert_eq!(
            upstream_refusal(403, &json!({ "status": "NOT_AUTHORIZED" }), "MSFT"),
            Ok(Some(PolygonFailure::new(PolygonErrorKind::PlanLimit, "Polygon plan does not include data for MSFT")))
        );
    }

    #[test]
    fn an_error_envelope_is_api_error_and_never_an_empty_answer() {
        // A 429 error envelope.
        assert_eq!(
            upstream_refusal(429, &json!({ "status": "ERROR", "error": "exceeded maximum requests" }), "AAPL"),
            Ok(Some(PolygonFailure::new(PolygonErrorKind::ApiError, "exceeded maximum requests")))
        );
        // An error envelope that arrived on a 200.
        assert_eq!(
            upstream_refusal(200, &json!({ "status": "ERROR", "error": "invalid date range requested" }), "AAPL"),
            Ok(Some(PolygonFailure::new(PolygonErrorKind::ApiError, "invalid date range requested")))
        );
        // A refusal with no envelope names the status.
        assert_eq!(
            upstream_refusal(429, &json!({}), "AAPL"),
            Ok(Some(PolygonFailure::new(PolygonErrorKind::ApiError, "Polygon refused the lookup for AAPL (HTTP 429)")))
        );
        assert_eq!(
            upstream_refusal(500, &json!({ "error": 5 }), "AAPL in [a, b]").unwrap().unwrap().message,
            "Polygon refused the lookup for AAPL in [a, b] (HTTP 500)"
        );
    }

    #[test]
    fn an_empty_answer_and_a_404_are_not_refusals() {
        assert_eq!(upstream_refusal(200, &json!({ "results": [] }), "NOSUCH"), Ok(None));
        assert_eq!(upstream_refusal(200, &json!({}), "NOSUCH"), Ok(None));
        // A 404 is Polygon saying it does not carry the symbol.
        assert_eq!(upstream_refusal(404, &json!({ "status": "NOT_FOUND" }), "NOSUCH"), Ok(None));
        assert_eq!(upstream_refusal(404, &json!({ "status": "ERROR" }), "NOSUCH").unwrap().unwrap().error.as_str(), "api_error");
        // A body that is JSON `null` has no status to read.
        assert_eq!(
            upstream_refusal(200, &Json::Null, "NOSUCH"),
            Err(Thrown::new("null is not an object (evaluating 'json.status')"))
        );
    }

    #[test]
    fn the_empty_result_memo_is_per_key() {
        let key = "price:TEST-MEMO:2024-01-15";
        assert!(!is_recent_miss(key));
        remember_miss(key);
        assert!(is_recent_miss(key));
        // Per symbol, and the price and detail memos are apart.
        assert!(!is_recent_miss("price:TEST-MEMO-OTHER:2024-01-15"));
        assert!(!is_recent_miss("detail:TEST-MEMO"));
        // An entry past its TTL is dropped on read.
        MISS_CACHE.lock().unwrap().insert(key.to_string(), JsDate::now_ms() - MISS_CACHE_TTL_MS);
        assert!(!is_recent_miss(key));
        assert!(!MISS_CACHE.lock().unwrap().contains_key(key));
    }

    #[test]
    fn a_shed_lookup_names_the_ticker() {
        let shed = rate_limited_result("MSFT");
        assert_eq!(shed.error.as_str(), "rate_limited");
        assert_eq!(shed.message, "Market data is busy right now; retry the lookup for MSFT in a moment.");
        assert_eq!(Caught::from(QueueWaitTimeoutError { waited_ms: 10.0 }), Caught::QueueWait);
    }

    #[test]
    fn failed_requests_read_like_buns_fetch() {
        // The client's cause chains as observed, and what Bun 1.4 says for the same failure.
        let failure = |refused: bool, closed: bool, causes: &[&str]| FetchFailure {
            refused,
            closed,
            host: Some("api.polygon.io".to_string()),
            causes: causes.iter().map(|cause| cause.to_string()).collect(),
        };
        let reset = "ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
        let refused = failure(true, false, &["client error (Connect)", "tcp connect error", "Connection refused (os error 111)"]);
        assert_eq!(
            describe_fetch_failure(&refused),
            "ECONNREFUSED: Unable to connect. Is the computer able to access the url?"
        );
        // A proxy that drops the tunnel, a peer that hangs up during the handshake, a reset mid-flight.
        assert_eq!(
            describe_fetch_failure(&failure(false, false, &["client error (Connect)", "tunnel error: unexpected end of file"])),
            reset
        );
        assert_eq!(describe_fetch_failure(&failure(false, false, &["client error (Connect)", "tls handshake eof"])), reset);
        assert_eq!(describe_fetch_failure(&failure(false, true, &["connection reset by peer"])), reset);
        let unresolved = failure(
            false,
            false,
            &["client error (Connect)", "dns error", "failed to lookup address information: Name or service not known"],
        );
        assert_eq!(describe_fetch_failure(&unresolved), "getaddrinfo ENOTFOUND api.polygon.io");
        assert_eq!(
            describe_fetch_failure(&failure(false, false, &["client error (Connect)", "invalid peer certificate: UnknownIssuer"])),
            "unable to verify the first certificate"
        );
        assert_eq!(
            describe_fetch_failure(&failure(
                false,
                false,
                &["client error (Connect)", "received corrupt message of type InvalidContentType"]
            )),
            "EPROTO: The TLS handshake failed. Does the server speak TLS on this port?"
        );
        // Anything else keeps the innermost cause's words, never the request line with its URL.
        assert_eq!(
            describe_fetch_failure(&failure(false, false, &["client error (Connect)", "tunnel error: unsuccessful"])),
            "tunnel error: unsuccessful"
        );
    }

    #[test]
    fn bodies_parse_the_way_bun_reads_them() {
        assert_eq!(parse_json_body(200, br#"{"results":[{"c":1.5}]}"#), Ok(json!({ "results": [{ "c": 1.5 }] })));
        // An empty body is `null`, except where the status never carries one.
        assert_eq!(parse_json_body(200, b""), Ok(Json::Null));
        assert_eq!(parse_json_body(503, b""), Ok(Json::Null));
        assert_eq!(parse_json_body(204, b""), Err(Thrown::new("Unexpected end of JSON input")));
        // A byte-order mark is dropped; bytes that are not UTF-8 are replaced.
        assert_eq!(parse_json_body(200, b"\xef\xbb\xbf{}"), Ok(json!({})));
        assert_eq!(
            parse_json_body(200, b"\xff\xfeA"),
            Err(Thrown::new("JSON Parse error: Unrecognized token '\u{fffd}'"))
        );
        assert_eq!(
            parse_json_body(502, b"<html><body>502</body></html>"),
            Err(Thrown::new("JSON Parse error: Unrecognized token '<'"))
        );
        assert_eq!(parse_json_body(200, b" "), Err(Thrown::new("JSON Parse error: Unexpected EOF")));
    }

    #[test]
    fn json_errors_read_like_javascriptcore() {
        // Each message as Bun 1.4 reports it for `JSON.parse(text)`.
        let cases: &[(&str, &str)] = &[
            (" ", "Unexpected EOF"),
            ("<html><body>502</body></html>", "Unrecognized token '<'"),
            ("Bad Gateway", "Unexpected identifier \"Bad\""),
            ("{", "Expected '}'"),
            ("{\"a\":", "Unexpected EOF"),
            ("[1,2", "Expected ']'"),
            ("{\"a\":1}x", "Unable to parse JSON string"),
            ("nul", "Unexpected identifier \"nul\""),
            ("{'a':1}", "Single quotes (') are not allowed in JSON"),
            ("\"abc", "Unterminated string"),
            ("{\"a\" 1}", "Expected ':' before value in object property definition"),
            ("{\"a\":1,}", "Property name must be a string literal"),
            ("{\"a\":1,\"b\" 2}", "Expected ':' before value in object property definition"),
            ("[1,]", "Unexpected comma at the end of array expression"),
            ("[1,,2]", "Unexpected token ','"),
            ("01", "Unable to parse JSON string"),
            ("1.", "Invalid digits after decimal point"),
            ("-", "Invalid number"),
            ("1e", "Unable to parse JSON string"),
            ("[1e]", "Expected ']'"),
            ("[1.5e+]", "Expected ']'"),
            ("NaN", "Unexpected identifier \"NaN\""),
            ("\u{e9}", "Unrecognized token '\u{e9}'"),
            ("\u{feff}{\"a\":1}", "Unrecognized token '\u{feff}'"),
            ("{\"a\":\"\\x\"}", "Invalid escape character x"),
            ("{a:1}", "Expected '}'"),
            ("}", "Unexpected token '}'"),
            ("]", "Unexpected token ']'"),
            (",", "Unexpected token ','"),
            (":", "Unexpected token ':'"),
            ("(1)", "Unexpected token '('"),
            (";", "Unexpected token ';'"),
            ("=", "Unexpected token '='"),
            (".5", "Unexpected token '.'"),
            ("1;", "Unable to parse JSON string"),
            ("\"a\tb\"", "Unterminated string"),
            ("+1", "Unrecognized token '+'"),
            ("true false", "Unable to parse JSON string"),
            ("truex", "Unable to parse JSON string"),
            ("[nullx]", "Expected ']'"),
            ("tru e", "Unexpected identifier \"tru\""),
            ("$a_1 b", "Unexpected identifier \"$a_1\""),
            ("a\u{e9}", "Unexpected identifier \"a\""),
            ("\"\\u12\"", "\\u must be followed by 4 hex digits"),
            ("\"\\u12zz\"", "\"\\u12zz\" is not a valid unicode escape"),
            ("\"\\u123\"", "\"\\u123\"\" is not a valid unicode escape"),
            ("\"\\u1234", "Unterminated string"),
            ("\"\\", "Unterminated string"),
            ("\u{1f4a5}", "Unrecognized token '\u{fffd}'"),
            ("1 @", "Unrecognized token '@'"),
            ("{\"a\":1} @", "Unrecognized token '@'"),
            ("[1] 'x'", "Single quotes (') are not allowed in JSON"),
            ("[", "Unexpected EOF"),
            ("[[", "Unexpected EOF"),
            ("{\"", "Unterminated string"),
            ("{\"a\"", "Expected ':' before value in object property definition"),
            ("{\"a\":1", "Expected '}'"),
            ("[}", "Unexpected token '}'"),
            ("{\"a\":[}", "Unexpected token '}'"),
            ("{\"a\":{]", "Expected '}'"),
            ("[1]]", "Unable to parse JSON string"),
            ("\u{a0}1", "Unrecognized token '\u{a0}'"),
            ("-Infinity", "Invalid number"),
            ("Infinity", "Unexpected identifier \"Infinity\""),
        ];
        for (text, reason) in cases {
            assert_eq!(json_parse_error(text), format!("JSON Parse error: {reason}"), "for {text:?}");
        }
    }

    #[test]
    fn upstream_json_reads_like_property_access() {
        let value = json!({ "a": { "b": [1, "xy"] }, "0": "zero" });
        assert_eq!(optional_member(member(&value, "a"), "b"), Some(&json!([1, "xy"])));
        assert_eq!(member(&json!([1]), "length"), None);
        assert_eq!(element_at(&json!([1, 2]), 1).as_deref(), Some(&json!(2)));
        assert_eq!(element_at(&json!("xy"), 1).as_deref(), Some(&json!("y")));
        assert_eq!(element_at(&value, 0).as_deref(), Some(&json!("zero")));
        assert_eq!(element_at(&json!(5), 0), None);
        assert_eq!(non_nullish(Some(&Json::Null)), None);
        assert_eq!(to_number(Some(&json!("12.5"))), 12.5);
        assert_eq!(to_number(Some(&json!(null))), 0.0);
        assert_eq!(to_number(Some(&json!([]))), 0.0);
        assert!(to_number(Some(&json!("-"))).is_nan());
        assert!(to_number(None).is_nan());
        assert_eq!(compare_strings("2026-03-04", "2026-03-10"), std::cmp::Ordering::Less);
    }
}
