//! Daily closes over a date range, both as traded (split-adjusted only) and
//! dividend-adjusted: `src/server/lib/daily-closes.ts`. Polygon is the primary
//! source, as everywhere else: its aggregates are split-adjusted only, so the
//! adjusted series is derived from its dividend history. Yahoo's chart, which
//! returns both series itself, is the fallback for symbols Polygon has no bars
//! for, chiefly mutual funds.
//!
//! How the TypeScript's shapes map here:
//!
//! - `PolygonResult<DailyClose[]>` is `PolygonResult<Vec<DailyClose>>`, that
//!   is `Result<Vec<DailyClose>, PolygonFailure>` (see the top of
//!   `polygon.rs`); the options are a `LookupOptions`.
//! - `DailyClosesPeek` (`PolygonResult | "loading" | undefined`) is
//!   `Option<DailyClosesPeek>`: `Answer(result)`, `Loading`, or `None`.
//! - The `loading` map of promises holds shared futures, each driven by its
//!   own task.
//! - [`get_daily_closes`] returns `anyhow::Result<…>`: the `Err` is where the
//!   TypeScript throws, which only the Yahoo fallback can (see `yahoo.rs`).

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, Once};

use futures::future::{BoxFuture, FutureExt, Shared};

use crate::js::{self, date_parse, encode_uri_component, js_slice_start, number_to_string, Json, JsDate};
use crate::server::logger;
use crate::server::polygon::{
    self, compare_strings, member, non_nullish, start_cache_sweep, to_number, Caught, LookupOptions, PolygonErrorKind,
    PolygonFailure, PolygonResult, Thrown,
};
use crate::server::yahoo;

/// One trading day of a fund: its close as traded and dividend-adjusted.
#[derive(Clone, Debug, PartialEq)]
pub struct DailyClose {
    /// YYYY-MM-DD, the trading day the bar belongs to.
    pub date: String,
    pub close: f64,
    pub adjusted_close: f64,
}

impl DailyClose {
    /// `{ date, close, adjustedClose }`, as the API answers it.
    pub fn to_json(&self) -> Json {
        let mut object = js::Obj::new();
        object.insert("date".into(), Json::String(self.date.clone()));
        object.insert("close".into(), js::num(self.close));
        object.insert("adjustedClose".into(), js::num(self.adjusted_close));
        Json::Object(object)
    }
}

/// A traded close, before the adjusted series is built.
#[derive(Clone, Debug, PartialEq)]
pub struct Bar {
    /// YYYY-MM-DD
    pub date: String,
    pub close: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Dividend {
    /// YYYY-MM-DD
    pub ex_date: String,
    pub cash_amount: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Split {
    /// YYYY-MM-DD
    pub date: String,
    /// New shares per old share.
    pub ratio: f64,
}

const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
const POLYGON_HOST: &str = "https://api.polygon.io";

struct Window {
    from: String,
    to: String,
    bars: Arc<Vec<DailyClose>>,
    fetched_at: f64,
}

/// Per symbol, the bars from the start of the earliest year asked for through
/// the day of the fetch. Any later range inside it is served without a call,
/// and starting on a year boundary means a request can't force a fresh fetch
/// by asking from a day earlier. The rate gate is shared with the price refresh
/// and the backfill, which can hold it for minutes.
static CACHE: LazyLock<Mutex<HashMap<String, Window>>> = LazyLock::new(Default::default);
const CACHE_TTL_MS: f64 = 60.0 * 60.0 * 1000.0;

struct Failure {
    result: PolygonFailure,
    failed_at: f64,
}

/// Failed fetches, briefly, so an unknown symbol doesn't spend calls on every retry.
static FAILURES: LazyLock<Mutex<HashMap<String, Failure>>> = LazyLock::new(Default::default);
const FAILURE_TTL_MS: f64 = 5.0 * 60.0 * 1000.0;

type Fetched = PolygonResult<Arc<Vec<DailyClose>>>;

/// Fetches with no deadline still running, so a caller can wait for one instead of queueing another.
static LOADING: LazyLock<Mutex<HashMap<String, Shared<BoxFuture<'static, Fetched>>>>> = LazyLock::new(Default::default);

static SWEEP: Once = Once::new();

fn sweep_caches() {
    let now = JsDate::now_ms();
    CACHE.lock().unwrap().retain(|_, entry| now - entry.fetched_at < CACHE_TTL_MS);
    FAILURES.lock().unwrap().retain(|_, entry| now - entry.failed_at < FAILURE_TTL_MS);
}

pub fn clear_daily_closes_cache() {
    CACHE.lock().unwrap().clear();
    FAILURES.lock().unwrap().clear();
    LOADING.lock().unwrap().clear();
}

/// The UTC day of a bar's timestamp. One that is not a time is the
/// TypeScript's `RangeError`.
fn to_date_string(timestamp: Option<&Json>) -> Result<String, Thrown> {
    let date = timestamp.map(JsDate::from_json).unwrap_or(JsDate::INVALID);
    match date.to_iso_string() {
        Some(iso) => Ok(js_slice_start(&iso, 10)),
        None => Err(Thrown::new("Invalid Date")),
    }
}

/// Back-adjusts traded closes for cash dividends, the way providers build an
/// adjusted series: every close before an ex-date is scaled by
/// `1 - dividend / close on the last day before it`. Dividends after the range
/// scale every bar by the same factor, so leaving them out changes no ratio
/// between two bars in it.
pub fn adjust_for_dividends(bars: &[Bar], dividends: &[Dividend]) -> Vec<DailyClose> {
    let mut adjusted: Vec<DailyClose> = Vec::with_capacity(bars.len());
    let mut factor = 1.0;
    for (i, bar) in bars.iter().enumerate().rev() {
        adjusted.push(DailyClose { date: bar.date.clone(), close: bar.close, adjusted_close: bar.close * factor });
        let Some(older) = i.checked_sub(1).and_then(|before| bars.get(before)) else { break };
        for d in dividends {
            if compare_strings(&d.ex_date, &older.date).is_gt() && compare_strings(&d.ex_date, &bar.date).is_le() {
                factor *= 1.0 - d.cash_amount / older.close;
            }
        }
    }
    adjusted.reverse();
    adjusted
}

/// Polygon's bars are adjusted for every split since, but its dividends are as
/// declared, so a dividend is restated per today's share by each later split.
pub fn split_adjust(dividends: &[Dividend], splits: &[Split]) -> Vec<Dividend> {
    dividends
        .iter()
        .map(|d| Dividend {
            ex_date: d.ex_date.clone(),
            cash_amount: splits.iter().fold(d.cash_amount, |amount, s| {
                if compare_strings(&s.date, &d.ex_date).is_gt() {
                    amount / s.ratio
                } else {
                    amount
                }
            }),
        })
        .collect()
}

fn polygon_failure(caught: Caught, ticker: &str) -> PolygonFailure {
    let message = match caught {
        Caught::QueueWait => return polygon::rate_limited_result(ticker),
        Caught::Error(message) => message,
    };
    logger::error(
        &format!("Polygon daily-closes error for {ticker}: {message}"),
        Some(&crate::ctx! { "component": "daily-closes" }),
        None,
    );
    PolygonFailure::new(PolygonErrorKind::ApiError, format!("Failed to fetch closes for {ticker}: {message}"))
}

/// One gated Polygon request: its JSON, and the refusal it carries if any.
async fn get_polygon_json(
    url: &str,
    subject: &str,
    max_wait_ms: Option<f64>,
) -> Result<(Json, Option<PolygonFailure>), Caught> {
    let response = polygon::POLYGON_QUEUE.add(|| polygon::fetch_with_default_retry(url), max_wait_ms).await??;
    let status = response.status().as_u16();
    let json = polygon::response_json(response).await?;
    let refusal = polygon::upstream_refusal(status, &json, subject)?;
    Ok((json, refusal))
}

// What the JavaScript engine says when an answer's `results` is there but is
// not a list. These end up in the failure message the caller is shown, so
// they are the engine's wording for the TypeScript's own expressions.
const BARS_NOT_A_LIST: &str = "(aggs.json.results ?? []).filter is not a function. (In '(aggs.json.results ?? []).filter((r) => Number.isFinite(r.c) && r.c > 0)', '(aggs.json.results ?? []).filter' is undefined)";
const DIVIDENDS_NOT_A_LIST: &str = "(divs.json.results ?? []).filter is not a function. (In '(divs.json.results ?? []).filter((d) => typeof d.ex_dividend_date === \"string\" && typeof d.cash_amount === \"number\")', '(divs.json.results ?? []).filter' is undefined)";
const SPLITS_NOT_A_LIST: &str = "(splitsResponse.json.results ?? []).filter is not a function. (In '(splitsResponse.json.results ?? []).filter((s) => typeof s.execution_date === \"string\" && (s.split_from ?? 0) > 0 && (s.split_to ?? 0) > 0)', '(splitsResponse.json.results ?? []).filter' is undefined)";

/// `json.results ?? []`, which the TypeScript then filters as a list.
fn results_of<'a>(json: &'a Json, not_a_list: &str) -> Result<&'a [Json], Thrown> {
    match non_nullish(member(json, "results")) {
        None => Ok(&[]),
        Some(Json::Array(results)) => Ok(results),
        Some(_) => Err(Thrown::new(not_a_list)),
    }
}

/// A member of `results`, which must be an object to be read; `field` is the
/// first thing the TypeScript reads from it.
fn readable<'a>(item: &'a Json, field: &str) -> Result<&'a Json, Thrown> {
    match item {
        Json::Null => Err(Thrown::new(format!("null is not an object (evaluating '{field}')"))),
        item => Ok(item),
    }
}

/// The bars of an aggregates answer: those with a positive close.
fn bars_of(json: &Json) -> Result<Vec<Bar>, Thrown> {
    let mut kept = Vec::new();
    for result in results_of(json, BARS_NOT_A_LIST)? {
        match member(readable(result, "r.c")?, "c") {
            Some(Json::Number(close)) if close.as_f64().map(|c| c.is_finite() && c > 0.0).unwrap_or(false) => {
                kept.push((result, close.as_f64().unwrap_or(f64::NAN)));
            }
            _ => {}
        }
    }
    kept.into_iter().map(|(result, close)| Ok(Bar { date: to_date_string(member(result, "t"))?, close })).collect()
}

/// The dividends of a dividends answer, as declared.
fn dividends_of(json: &Json) -> Result<Vec<Dividend>, Thrown> {
    let mut declared = Vec::new();
    for result in results_of(json, DIVIDENDS_NOT_A_LIST)? {
        let result = readable(result, "d.ex_dividend_date")?;
        if let (Some(Json::String(ex_date)), Some(Json::Number(cash_amount))) =
            (member(result, "ex_dividend_date"), member(result, "cash_amount"))
        {
            declared.push(Dividend { ex_date: ex_date.clone(), cash_amount: cash_amount.as_f64().unwrap_or(f64::NAN) });
        }
    }
    Ok(declared)
}

/// The splits of a splits answer that name a day and a positive ratio.
fn splits_of(json: &Json) -> Result<Vec<Split>, Thrown> {
    let mut splits = Vec::new();
    for result in results_of(json, SPLITS_NOT_A_LIST)? {
        let result = readable(result, "s.execution_date")?;
        let Some(Json::String(date)) = member(result, "execution_date") else { continue };
        // `(s.split_from ?? 0) > 0`: a missing side counts as zero.
        let side = |name: &str| non_nullish(member(result, name)).map(|value| to_number(Some(value))).unwrap_or(0.0);
        let (split_from, split_to) = (side("split_from"), side("split_to"));
        if split_from > 0.0 && split_to > 0.0 {
            splits.push(Split { date: date.clone(), ratio: split_to / split_from });
        }
    }
    Ok(splits)
}

fn aggregates_url(encoded_ticker: &str, from: &str, to: &str, api_key: &str) -> String {
    format!(
        "{POLYGON_HOST}/v2/aggs/ticker/{encoded_ticker}/range/1/day/{from}/{to}?adjusted=true&sort=asc&limit=50000&apiKey={api_key}"
    )
}

fn dividends_url(ticker: &str, from: &str, to: &str, api_key: &str) -> String {
    format!(
        "{POLYGON_HOST}/v3/reference/dividends?ticker={}&ex_dividend_date.gte={from}&ex_dividend_date.lte={to}&limit=1000&apiKey={api_key}",
        encode_uri_component(ticker)
    )
}

fn splits_url(ticker: &str, from: &str, api_key: &str) -> String {
    format!(
        "{POLYGON_HOST}/v3/reference/splits?ticker={}&execution_date.gte={from}&limit=1000&apiKey={api_key}",
        encode_uri_component(ticker)
    )
}

async fn get_polygon_daily_closes(
    ticker_symbol: &str,
    from: &str,
    to: &str,
    options: &LookupOptions,
) -> PolygonResult<Vec<DailyClose>> {
    let Some(api_key) = std::env::var("POLYGON_API_KEY").ok().filter(|key| !key.is_empty()) else {
        return Err(PolygonFailure::new(PolygonErrorKind::NoApiKey, "Polygon API key not configured"));
    };
    let ticker = polygon::to_polygon_ticker(ticker_symbol, options.security_type.as_deref());
    let encoded = polygon::encode_ticker(&ticker);
    // One budget across every call, so a caller's wait covers the whole fetch.
    let deadline = options.max_wait_ms.filter(|ms| *ms != 0.0 && !ms.is_nan()).map(|ms| JsDate::now_ms() + ms);
    let remaining = || deadline.map(|deadline| (deadline - JsDate::now_ms()).max(1.0));

    let attempt = async {
        let (aggs, refusal) = get_polygon_json(
            &aggregates_url(&encoded, from, to, &api_key),
            &format!("{ticker} in [{from}, {to}]"),
            remaining(),
        )
        .await?;
        if let Some(refusal) = refusal {
            return Ok(Err(refusal));
        }
        let bars = bars_of(&aggs)?;
        if bars.is_empty() {
            return Ok(Err(PolygonFailure::new(
                PolygonErrorKind::NoData,
                format!("No daily closes for {ticker} between {from} and {to}"),
            )));
        }

        let (divs, refusal) =
            get_polygon_json(&dividends_url(&ticker, from, to, &api_key), &format!("{ticker} dividends"), remaining())
                .await?;
        if let Some(refusal) = refusal {
            return Ok(Err(refusal));
        }
        let declared = dividends_of(&divs)?;
        if declared.is_empty() {
            return Ok(Ok(adjust_for_dividends(&bars, &declared)));
        }

        let (splits_response, refusal) =
            get_polygon_json(&splits_url(&ticker, from, &api_key), &format!("{ticker} splits"), remaining()).await?;
        if let Some(refusal) = refusal {
            return Ok(Err(refusal));
        }
        let splits = splits_of(&splits_response)?;

        Ok::<PolygonResult<Vec<DailyClose>>, Caught>(Ok(adjust_for_dividends(&bars, &split_adjust(&declared, &splits))))
    };
    match attempt.await {
        Ok(result) => result,
        Err(caught) => Err(polygon_failure(caught, &ticker)),
    }
}

/// The chart query for every bar from `from` through the end of `to`.
fn yahoo_query(from: &str, to: &str) -> String {
    let period1 = (date_parse(&format!("{from}T00:00:00Z")) / 1000.0).floor();
    let period2 = ((date_parse(&format!("{to}T00:00:00Z")) + DAY_MS) / 1000.0).floor();
    format!("interval=1d&period1={}&period2={}", number_to_string(period1), number_to_string(period2))
}

/// The bars of a Yahoo chart within `[from, to]` that carry both a close and
/// an adjusted close.
fn yahoo_bars(chart: &Json, from: &str, to: &str) -> Result<Vec<DailyClose>, Thrown> {
    let timestamps = match yahoo::timestamps_of(chart) {
        None => return Ok(Vec::new()),
        Some(Json::Array(timestamps)) => timestamps,
        Some(_) => return Err(Thrown::new("timestamps.forEach is not a function")),
    };
    let closes = yahoo::series_of(chart, "quote", "close");
    let adjusted = yahoo::series_of(chart, "adjclose", "adjclose");
    let mut bars = Vec::new();
    for (i, t) in timestamps.iter().enumerate() {
        let Some(close) = yahoo::number_at(closes, i).filter(|close| *close > 0.0) else { continue };
        let Some(adjusted_close) = yahoo::number_at(adjusted, i).filter(|adjusted| *adjusted > 0.0) else { continue };
        let date = yahoo::date_string_of_timestamp(to_number(Some(t)));
        if compare_strings(&date, from).is_lt() || compare_strings(&date, to).is_gt() {
            continue;
        }
        bars.push(DailyClose { date, close, adjusted_close });
    }
    Ok(bars)
}

async fn get_yahoo_daily_closes(
    ticker_symbol: &str,
    from: &str,
    to: &str,
    options: &LookupOptions,
) -> anyhow::Result<PolygonResult<Vec<DailyClose>>> {
    let yahoo_ticker = yahoo::to_yahoo_ticker(ticker_symbol, options.security_type.as_deref());
    let chart = match yahoo::fetch_chart(&yahoo_ticker, &yahoo_query(from, to), options.max_wait_ms).await? {
        Ok(chart) => chart,
        Err(failure) => return Ok(Err(failure)),
    };

    let bars = yahoo_bars(&chart, from, to)?;
    if bars.is_empty() {
        return Ok(Err(PolygonFailure::new(
            PolygonErrorKind::NoData,
            format!("No daily closes for {ticker_symbol} between {from} and {to}"),
        )));
    }
    Ok(Ok(bars))
}

fn key_of(ticker_symbol: &str, security_type: Option<&str>) -> String {
    format!("{ticker_symbol}:{}", security_type.unwrap_or(""))
}

fn year_start(date: &str) -> String {
    format!("{}-01-01", js_slice_start(date, 4))
}

/// Today's date in UTC, the last day a window can cover.
fn today() -> String {
    js_slice_start(&JsDate::now().to_iso_string().unwrap_or_default(), 10)
}

fn in_range(bars: &[DailyClose], ticker_symbol: &str, from: &str, to: &str) -> PolygonResult<Vec<DailyClose>> {
    let within: Vec<DailyClose> = bars
        .iter()
        .filter(|b| compare_strings(&b.date, from).is_ge() && compare_strings(&b.date, to).is_le())
        .cloned()
        .collect();
    if !within.is_empty() {
        return Ok(within);
    }
    Err(PolygonFailure::new(
        PolygonErrorKind::NoData,
        format!("No daily closes for {ticker_symbol} between {from} and {to}"),
    ))
}

/// What [`peek_daily_closes`] found.
#[derive(Clone, Debug, PartialEq)]
pub enum DailyClosesPeek {
    /// Cached bars, or a recent failure.
    Answer(PolygonResult<Vec<DailyClose>>),
    /// A fetch for the symbol is still running.
    Loading,
}

/// What a call would answer without reaching the rate gate: cached bars, a
/// recent failure, `Loading` while a fetch for the symbol is still running,
/// or `None` when a call is needed.
pub fn peek_daily_closes(ticker_symbol: &str, from: &str, to: &str, security_type: Option<&str>) -> Option<DailyClosesPeek> {
    let key = key_of(ticker_symbol, security_type);
    if let Some(cached) = CACHE.lock().unwrap().get(&key) {
        if JsDate::now_ms() - cached.fetched_at < CACHE_TTL_MS
            && compare_strings(&cached.from, from).is_le()
            && compare_strings(&cached.to, to).is_ge()
        {
            return Some(DailyClosesPeek::Answer(in_range(&cached.bars, ticker_symbol, from, to)));
        }
    }
    if let Some(failed) = FAILURES.lock().unwrap().get(&format!("{key}:{}", year_start(from))) {
        if JsDate::now_ms() - failed.failed_at < FAILURE_TTL_MS {
            return Some(DailyClosesPeek::Answer(Err(failed.result.clone())));
        }
    }
    if LOADING.lock().unwrap().contains_key(&key) {
        return Some(DailyClosesPeek::Loading);
    }
    None
}

/// Keeps a window's bars for later asks, or its failure for a while. A busy
/// gate is neither: the next ask can try again.
fn remember(key: &str, window_from: &str, to: &str, result: &Fetched) {
    match result {
        Ok(bars) => {
            let window =
                Window { from: window_from.to_string(), to: to.to_string(), bars: bars.clone(), fetched_at: JsDate::now_ms() };
            CACHE.lock().unwrap().insert(key.to_string(), window);
        }
        Err(failure) if failure.error != PolygonErrorKind::RateLimited => {
            let failed = Failure { result: failure.clone(), failed_at: JsDate::now_ms() };
            FAILURES.lock().unwrap().insert(format!("{key}:{window_from}"), failed);
        }
        Err(_) => return,
    }
    start_cache_sweep(&SWEEP, sweep_caches);
}

async fn fetch_window(ticker_symbol: &str, from: &str, options: &LookupOptions) -> anyhow::Result<Fetched> {
    let key = key_of(ticker_symbol, options.security_type.as_deref());
    let window_from = year_start(from);
    let to = today();
    let mut result = get_polygon_daily_closes(ticker_symbol, &window_from, &to, options).await;
    if matches!(&result, Err(failure) if failure.error == PolygonErrorKind::NoData) {
        result = get_yahoo_daily_closes(ticker_symbol, &window_from, &to, options).await?;
    }
    let result = result.map(Arc::new);
    remember(&key, &window_from, &to, &result);
    Ok(result)
}

/// Starts a fetch with no deadline, if none is running for the symbol, so the
/// cache is warm when the caller asks again. Its result is only cached.
pub fn warm_daily_closes(ticker_symbol: &str, from: &str, security_type: Option<&str>) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
    let key = key_of(ticker_symbol, security_type);
    let mut loading = LOADING.lock().unwrap();
    if loading.contains_key(&key) {
        return;
    }
    let (ticker_symbol, from, finished) = (ticker_symbol.to_string(), from.to_string(), key.clone());
    let options = LookupOptions { security_type: security_type.map(str::to_string), ..Default::default() };
    let pending: Shared<BoxFuture<'static, Fetched>> = async move {
        let result = match fetch_window(&ticker_symbol, &from, &options).await {
            Ok(result) => result,
            Err(thrown) => Err(polygon_failure(Caught::Error(thrown.to_string()), &ticker_symbol)),
        };
        LOADING.lock().unwrap().remove(&finished);
        result
    }
    .boxed()
    .shared();
    loading.insert(key, pending.clone());
    drop(loading);
    runtime.spawn(pending);
}

/// `from` and `to` are YYYY-MM-DD and inclusive. Bars come back oldest first.
pub async fn get_daily_closes(
    ticker_symbol: &str,
    from: &str,
    to: &str,
    options: &LookupOptions,
) -> anyhow::Result<PolygonResult<Vec<DailyClose>>> {
    match peek_daily_closes(ticker_symbol, from, to, options.security_type.as_deref()) {
        Some(DailyClosesPeek::Loading) => return Ok(Err(polygon::rate_limited_result(ticker_symbol))),
        Some(DailyClosesPeek::Answer(answer)) => return Ok(answer),
        None => {}
    }
    Ok(match fetch_window(ticker_symbol, from, options).await? {
        Ok(bars) => in_range(&bars, ticker_symbol, from, to),
        Err(failure) => Err(failure),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::polygon::tests::with_env;
    use serde_json::json;

    fn bar(date: &str, close: f64) -> Bar {
        Bar { date: date.to_string(), close }
    }

    fn dividend(ex_date: &str, cash_amount: f64) -> Dividend {
        Dividend { ex_date: ex_date.to_string(), cash_amount }
    }

    fn close(date: &str, close: f64, adjusted_close: f64) -> DailyClose {
        DailyClose { date: date.to_string(), close, adjusted_close }
    }

    fn assert_close_to(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 5e-11, "{actual} is not close to {expected}");
    }

    fn yahoo_ts(year: i64, month: i64, day: i64) -> f64 {
        (JsDate::from_utc(year, month - 1, day, 14, 30, 0, 0).get_time() / 1000.0).floor()
    }

    /// Polygon stamps a daily bar at the session's start in New York, in ms.
    fn polygon_ts(year: i64, month: i64, day: i64) -> f64 {
        JsDate::from_utc(year, month - 1, day, 5, 0, 0, 0).get_time()
    }

    fn yahoo_chart(timestamps: Json, closes: Json, adjusted: Option<Json>) -> Json {
        let mut indicators = json!({ "quote": [{ "close": closes }] });
        if let Some(adjusted) = adjusted {
            indicators["adjclose"] = json!([{ "adjclose": adjusted }]);
        }
        json!({ "timestamp": timestamps, "indicators": indicators })
    }

    #[test]
    fn scales_every_close_before_an_ex_date_by_one_minus_the_dividend_over_the_prior_close() {
        let bars = [bar("2026-03-02", 100.0), bar("2026-03-03", 102.0), bar("2026-03-04", 99.0)];
        let adjusted = adjust_for_dividends(&bars, &[dividend("2026-03-04", 2.04)]);
        assert_eq!(adjusted.iter().map(|b| b.close).collect::<Vec<_>>(), vec![100.0, 102.0, 99.0]);
        assert_eq!(adjusted[2].adjusted_close, 99.0);
        assert_close_to(adjusted[1].adjusted_close, 102.0 * (1.0 - 2.04 / 102.0));
        assert_close_to(adjusted[0].adjusted_close, 100.0 * (1.0 - 2.04 / 102.0));
    }

    #[test]
    fn an_ex_date_on_a_non_trading_day_applies_at_the_next_bar() {
        let bars = [bar("2026-03-06", 50.0), bar("2026-03-09", 49.0)];
        let adjusted = adjust_for_dividends(&bars, &[dividend("2026-03-07", 1.0)]);
        assert_close_to(adjusted[0].adjusted_close, 49.0);
        assert_eq!(adjusted[1].adjusted_close, 49.0);
    }

    #[test]
    fn split_adjust_divides_a_dividend_by_every_split_after_its_ex_date_only() {
        let splits = [Split { date: "2026-03-10".into(), ratio: 2.0 }, Split { date: "2026-09-10".into(), ratio: 10.0 }];
        let dividends = [dividend("2026-03-01", 4.0), dividend("2026-06-01", 4.0), dividend("2026-09-10", 4.0)];
        assert_eq!(
            split_adjust(&dividends, &splits),
            vec![dividend("2026-03-01", 0.2), dividend("2026-06-01", 0.4), dividend("2026-09-10", 4.0)]
        );
    }

    #[test]
    fn carries_the_dividends_the_import_reads_back_out_of_the_two_series() {
        let bars = [
            bar("2026-03-02", 100.0),
            bar("2026-03-03", 102.0),
            bar("2026-03-04", 99.0),
            bar("2026-06-01", 104.0),
            bar("2026-06-02", 103.2),
        ];
        let dividends = [dividend("2026-03-04", 2.04), dividend("2026-06-02", 0.8125)];
        let adjusted = adjust_for_dividends(&bars, &dividends);
        // `distributionsFromCloses` of `src/common/plan-statement/reinvest.ts`:
        // the ratio of adjusted to raw close steps on each ex-date.
        let mut distributions = Vec::new();
        for pair in adjusted.windows(2) {
            let (prior, bar) = (&pair[0], &pair[1]);
            let payout_share = 1.0 - prior.adjusted_close / prior.close / (bar.adjusted_close / bar.close);
            if payout_share <= 1e-4 {
                continue;
            }
            let cash_amount = js::math_round(prior.close * payout_share * 1e6) / 1e6;
            distributions.push((bar.date.clone(), cash_amount, bar.close));
        }
        assert_eq!(distributions, vec![("2026-03-04".to_string(), 2.04, 99.0), ("2026-06-02".to_string(), 0.8125, 103.2)]);
    }

    #[test]
    fn builds_the_adjusted_series_from_polygons_bars_and_dividends() {
        let aggs = json!({
            "status": "OK",
            "results": [{ "c": 100, "t": polygon_ts(2026, 3, 2) }, { "c": 99, "t": polygon_ts(2026, 3, 3) }],
        });
        let divs = json!({ "status": "OK", "results": [{ "ex_dividend_date": "2026-03-03", "cash_amount": 1 }] });
        let bars = bars_of(&aggs).unwrap();
        assert_eq!(bars, vec![bar("2026-03-02", 100.0), bar("2026-03-03", 99.0)]);
        let declared = dividends_of(&divs).unwrap();
        assert_eq!(declared, vec![dividend("2026-03-03", 1.0)]);
        assert_eq!(
            adjust_for_dividends(&bars, &declared),
            vec![close("2026-03-02", 100.0, 99.0), close("2026-03-03", 99.0, 99.0)]
        );
    }

    #[test]
    fn requests_the_window_from_polygon() {
        // From the start of the year through today, whatever day in it was asked for.
        assert_eq!(year_start("2026-03-02"), "2026-01-01");
        let aggs = aggregates_url(&polygon::encode_ticker("XPUB"), &year_start("2026-03-02"), &today(), "test-key");
        assert_eq!(
            aggs,
            format!(
                "https://api.polygon.io/v2/aggs/ticker/XPUB/range/1/day/2026-01-01/{}?adjusted=true&sort=asc&limit=50000&apiKey=test-key",
                js_slice_start(&JsDate::now().to_iso_string().unwrap(), 10)
            )
        );
        assert_eq!(
            dividends_url("XPUB", "2026-01-01", "2026-11-21", "test-key"),
            "https://api.polygon.io/v3/reference/dividends?ticker=XPUB&ex_dividend_date.gte=2026-01-01&ex_dividend_date.lte=2026-11-21&limit=1000&apiKey=test-key"
        );
        assert_eq!(
            splits_url("XPUB", "2026-01-01", "test-key"),
            "https://api.polygon.io/v3/reference/splits?ticker=XPUB&execution_date.gte=2026-01-01&limit=1000&apiKey=test-key"
        );
        // The crypto namespace keeps its colon in the path and is escaped in a query.
        let crypto = polygon::to_polygon_ticker("BTC", Some("cryptocurrency"));
        assert!(aggregates_url(&polygon::encode_ticker(&crypto), "a", "b", "k").contains("/ticker/X:BTCUSD/range/"));
        assert!(dividends_url(&crypto, "a", "b", "k").contains("?ticker=X%3ABTCUSD&"));
    }

    #[test]
    fn restates_a_dividend_declared_before_a_later_split_per_todays_share() {
        let bars = [bar("2026-03-02", 10.0), bar("2026-03-03", 9.9)];
        let declared = [dividend("2026-03-03", 1.0)];
        let splits = splits_of(&json!({
            "status": "OK",
            "results": [{ "execution_date": "2026-06-10", "split_from": 1, "split_to": 10 }],
        }))
        .unwrap();
        assert_eq!(splits, vec![Split { date: "2026-06-10".into(), ratio: 10.0 }]);
        let adjusted = adjust_for_dividends(&bars, &split_adjust(&declared, &splits));
        assert_close_to(adjusted[0].adjusted_close, 9.9);
    }

    #[test]
    fn keeps_only_the_usable_rows_of_each_polygon_answer() {
        let aggs = json!({ "results": [
            { "c": 0, "t": polygon_ts(2026, 3, 2) },
            { "c": -1, "t": polygon_ts(2026, 3, 3) },
            { "c": "5", "t": polygon_ts(2026, 3, 4) },
            { "t": polygon_ts(2026, 3, 5) },
            7,
            { "c": 12.5, "t": polygon_ts(2026, 3, 6) },
        ] });
        assert_eq!(bars_of(&aggs).unwrap(), vec![bar("2026-03-06", 12.5)]);
        assert_eq!(bars_of(&json!({ "status": "OK", "resultsCount": 0 })).unwrap(), vec![]);
        assert_eq!(bars_of(&json!({ "results": null })).unwrap(), vec![]);
        // A kept bar needs a timestamp; a dropped one does not.
        assert_eq!(bars_of(&json!({ "results": [{ "c": 1 }] })), Err(Thrown::new("Invalid Date")));
        assert_eq!(bars_of(&json!({ "results": [{ "c": 0 }] })).unwrap(), vec![]);
        assert_eq!(
            bars_of(&json!({ "results": [null] })),
            Err(Thrown::new("null is not an object (evaluating 'r.c')"))
        );
        // A `results` that is there but is not a list fails as the engine words it.
        assert_eq!(bars_of(&json!({ "results": {} })), Err(Thrown::new(BARS_NOT_A_LIST)));
        assert_eq!(bars_of(&json!({ "results": 0 })), Err(Thrown::new(BARS_NOT_A_LIST)));
        assert_eq!(dividends_of(&json!({ "results": "abc" })), Err(Thrown::new(DIVIDENDS_NOT_A_LIST)));
        assert_eq!(splits_of(&json!({ "results": false })), Err(Thrown::new(SPLITS_NOT_A_LIST)));
        assert_eq!(
            dividends_of(&json!({ "results": [null] })),
            Err(Thrown::new("null is not an object (evaluating 'd.ex_dividend_date')"))
        );
        assert_eq!(
            splits_of(&json!({ "results": [null] })),
            Err(Thrown::new("null is not an object (evaluating 's.execution_date')"))
        );

        let divs = json!({ "results": [
            { "ex_dividend_date": "2026-03-03", "cash_amount": "1" },
            { "ex_dividend_date": 20260303, "cash_amount": 1 },
            { "cash_amount": 1 },
            { "ex_dividend_date": "2026-03-04", "cash_amount": 0.25 },
        ] });
        assert_eq!(dividends_of(&divs).unwrap(), vec![dividend("2026-03-04", 0.25)]);

        let splits = json!({ "results": [
            { "execution_date": "2026-06-10", "split_from": 0, "split_to": 10 },
            { "execution_date": "2026-06-11", "split_to": 10 },
            { "execution_date": "2026-06-12", "split_from": 1, "split_to": null },
            { "split_from": 1, "split_to": 2 },
            { "execution_date": "2026-06-13", "split_from": 4, "split_to": 1 },
        ] });
        assert_eq!(splits_of(&splits).unwrap(), vec![Split { date: "2026-06-13".into(), ratio: 0.25 }]);
    }

    #[test]
    fn reads_yahoos_own_adjusted_series() {
        let chart = yahoo_chart(
            json!([yahoo_ts(2026, 3, 2), yahoo_ts(2026, 3, 3), yahoo_ts(2026, 3, 4)]),
            json!([50, null, 52]),
            Some(json!([40, 41, 42])),
        );
        assert_eq!(
            yahoo_bars(&chart, "2026-03-02", "2026-03-04").unwrap(),
            vec![close("2026-03-02", 50.0, 40.0), close("2026-03-04", 52.0, 42.0)]
        );
        // Bars outside the range asked for are left out.
        assert_eq!(yahoo_bars(&chart, "2026-03-03", "2026-03-04").unwrap(), vec![close("2026-03-04", 52.0, 42.0)]);
    }

    #[test]
    fn asks_yahoo_from_the_first_day_through_the_end_of_the_last() {
        let start = JsDate::from_utc(2026, 0, 1, 0, 0, 0, 0).get_time() / 1000.0;
        let end = JsDate::from_utc(2026, 2, 4, 0, 0, 0, 0).get_time() / 1000.0 + 86_400.0;
        assert_eq!(yahoo_query("2026-01-01", "2026-03-04"), format!("interval=1d&period1={start}&period2={end}"));
        assert_eq!(yahoo_query("2026-01-01", "2026-03-04"), "interval=1d&period1=1767225600&period2=1772668800");
    }

    #[test]
    fn a_yahoo_answer_without_adjusted_closes_is_no_data_rather_than_a_raw_close_series() {
        let chart = yahoo_chart(json!([yahoo_ts(2026, 3, 2)]), json!([50]), None);
        assert_eq!(yahoo_bars(&chart, "2026-03-02", "2026-03-02").unwrap(), vec![]);
        assert_eq!(yahoo_bars(&json!({}), "2026-03-02", "2026-03-02").unwrap(), vec![]);
        assert!(yahoo_bars(&json!({ "timestamp": 5 }), "2026-03-02", "2026-03-02").is_err());
    }

    #[tokio::test]
    async fn an_unconfigured_polygon_surfaces_as_is_instead_of_falling_back() {
        with_env(&[("POLYGON_API_KEY", Some(""))], async {
            let result = get_daily_closes("XNOKEY", "2026-03-02", "2026-03-02", &LookupOptions::default()).await.unwrap();
            assert_eq!(result, Err(PolygonFailure::new(PolygonErrorKind::NoApiKey, "Polygon API key not configured")));
            // And it is remembered as that symbol's answer for the year.
            assert_eq!(
                peek_daily_closes("XNOKEY", "2026-06-01", "2026-06-30", None),
                Some(DailyClosesPeek::Answer(Err(PolygonFailure::new(
                    PolygonErrorKind::NoApiKey,
                    "Polygon API key not configured"
                ))))
            );
            assert_eq!(peek_daily_closes("XNOKEY", "2025-06-01", "2025-06-30", None), None);
        })
        .await;
    }

    #[test]
    fn serves_any_range_inside_the_fetched_window_from_memory_wherever_in_the_year_it_starts() {
        let bars = Arc::new(vec![close("2026-03-02", 100.0, 100.0), close("2026-03-09", 101.0, 101.0)]);
        let key = key_of("XWINDOW", None);
        remember(&key, "2026-01-01", "2026-11-21", &Ok(bars));

        let later = peek_daily_closes("XWINDOW", "2026-03-05", "2026-03-09", None);
        assert_eq!(later, Some(DailyClosesPeek::Answer(Ok(vec![close("2026-03-09", 101.0, 101.0)]))));
        // A day earlier, the shape a script would use to force a fresh fetch, and the year's first day.
        assert!(matches!(
            peek_daily_closes("XWINDOW", "2026-03-01", "2026-03-09", None),
            Some(DailyClosesPeek::Answer(Ok(bars))) if bars.len() == 2
        ));
        assert!(peek_daily_closes("XWINDOW", "2026-01-01", "2026-03-09", None).is_some());
        // A range of the window with no bar in it is an answer too.
        assert_eq!(
            peek_daily_closes("XWINDOW", "2026-04-01", "2026-04-30", None),
            Some(DailyClosesPeek::Answer(Err(PolygonFailure::new(
                PolygonErrorKind::NoData,
                "No daily closes for XWINDOW between 2026-04-01 and 2026-04-30"
            ))))
        );
        // Before the window, past its last day, or for another security type, a fetch is needed.
        assert_eq!(peek_daily_closes("XWINDOW", "2025-12-20", "2026-03-09", None), None);
        assert_eq!(peek_daily_closes("XWINDOW", "2026-03-05", "2026-11-22", None), None);
        assert_eq!(peek_daily_closes("XWINDOW", "2026-03-05", "2026-03-09", Some("cryptocurrency")), None);

        // A window past its TTL is no longer served.
        CACHE.lock().unwrap().get_mut(&key).unwrap().fetched_at = JsDate::now_ms() - CACHE_TTL_MS;
        assert_eq!(peek_daily_closes("XWINDOW", "2026-03-05", "2026-03-09", None), None);
    }

    #[test]
    fn remembers_a_symbol_with_no_data_on_either_source_for_a_while() {
        let failure = PolygonFailure::new(PolygonErrorKind::NoData, "No Yahoo data found for XNONE");
        let key = key_of("XNONE", None);
        remember(&key, "2026-01-01", "2026-11-21", &Err(failure.clone()));
        assert_eq!(
            peek_daily_closes("XNONE", "2026-03-05", "2026-03-05", None),
            Some(DailyClosesPeek::Answer(Err(failure)))
        );
        // Another year is another window.
        assert_eq!(peek_daily_closes("XNONE", "2025-03-05", "2025-03-05", None), None);
        FAILURES.lock().unwrap().get_mut(&format!("{key}:2026-01-01")).unwrap().failed_at =
            JsDate::now_ms() - FAILURE_TTL_MS;
        assert_eq!(peek_daily_closes("XNONE", "2026-03-05", "2026-03-05", None), None);
    }

    #[test]
    fn a_busy_gate_isnt_remembered_as_a_failure_so_the_next_ask_can_try_again() {
        remember(&key_of("XBUSY", None), "2026-01-01", "2026-11-21", &Err(polygon::rate_limited_result("XBUSY")));
        assert_eq!(peek_daily_closes("XBUSY", "2026-03-02", "2026-03-02", None), None);
    }

    #[tokio::test]
    async fn a_background_warm_up_is_reported_as_loading() {
        with_env(&[("POLYGON_API_KEY", Some("test-key")), ("POLYGON_RATE_LIMIT_PER_MIN", Some("1"))], async {
            polygon::POLYGON_QUEUE.reset();
            // The gate's one slot of the minute is taken, so the warm-up's fetch queues behind it.
            polygon::POLYGON_QUEUE.add(|| async {}, None).await.unwrap();
            warm_daily_closes("XWARM", "2026-03-02", None);
            warm_daily_closes("XWARM", "2026-03-02", None);
            assert_eq!(peek_daily_closes("XWARM", "2026-03-02", "2026-03-02", None), Some(DailyClosesPeek::Loading));
            let asked = get_daily_closes("XWARM", "2026-03-02", "2026-03-02", &LookupOptions::default()).await.unwrap();
            assert_eq!(asked, Err(polygon::rate_limited_result("XWARM")));
            // The same symbol as another kind of security is another fetch.
            assert_eq!(peek_daily_closes("XWARM", "2026-03-02", "2026-03-02", Some("cryptocurrency")), None);

            // A caller with a wait budget gives up within it, and that is not remembered as a failure.
            let waiting = LookupOptions { max_wait_ms: Some(10.0), ..Default::default() };
            let shed = get_daily_closes("XSHED", "2026-03-02", "2026-03-02", &waiting).await.unwrap();
            assert_eq!(shed, Err(polygon::rate_limited_result("XSHED")));
            assert_eq!(peek_daily_closes("XSHED", "2026-03-02", "2026-03-02", None), None);

            LOADING.lock().unwrap().remove(&key_of("XWARM", None));
            polygon::POLYGON_QUEUE.reset();
        })
        .await;
    }

    #[test]
    fn a_wait_budget_error_and_any_other_error_read_differently() {
        assert_eq!(polygon_failure(Caught::QueueWait, "XPUB"), polygon::rate_limited_result("XPUB"));
        assert_eq!(
            polygon_failure(Caught::Error("HTTP 503".into()), "XPUB"),
            PolygonFailure::new(PolygonErrorKind::ApiError, "Failed to fetch closes for XPUB: HTTP 503")
        );
    }

    #[test]
    fn closes_serialize_with_the_api_field_names() {
        assert_eq!(
            close("2026-03-02", 100.0, 98.5).to_json(),
            json!({ "date": "2026-03-02", "close": 100, "adjustedClose": 98.5 })
        );
        assert_eq!(js::json_stringify(&close("2026-03-02", 100.0, 99.0).to_json()), r#"{"date":"2026-03-02","close":100,"adjustedClose":99}"#);
    }
}
