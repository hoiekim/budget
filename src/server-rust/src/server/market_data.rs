//! Market-data provider policy: Polygon is the primary source; Yahoo Finance
//! (keyless) is the fallback for symbols Polygon answers `no_data` on,
//! chiefly mutual funds, which never touch an exchange tape:
//! `src/server/lib/market-data.ts`.
//!
//! Only an empty answer is a verdict on the symbol, so every other Polygon
//! failure (rate-limited, refused, unconfigured) surfaces as-is and never
//! triggers the fallback: the same rule the validate-ticker route applies to
//! keep a sick lookup from mislabeling a good ticker.
//!
//! Results and options are `polygon.rs`'s (`PolygonResult<T>` is `Result<T,
//! PolygonFailure>`; see the top of that file). Each function returns
//! `anyhow::Result<…>` because the Yahoo lookup it may fall back to can fail
//! where the TypeScript throws.

use crate::js::JsDate;
use crate::server::logger;
use crate::server::polygon::{self, Close, DateOrString, LookupOptions, PolygonErrorKind, PolygonResult, TickerDetail};
use crate::server::yahoo;

fn note_fallback(function: &str, ticker_symbol: &str) {
    logger::info(
        &format!("market-data: Polygon had no data for {ticker_symbol}; falling back to Yahoo ({function})"),
        Some(&crate::ctx! { "component": "market-data" }),
    );
}

/// Whether Polygon's answer hands the lookup to Yahoo: only when it had no data.
fn falls_back<T>(primary: &PolygonResult<T>) -> bool {
    matches!(primary, Err(failure) if failure.error == PolygonErrorKind::NoData)
}

pub async fn get_ticker_detail_with_fallback(
    ticker_symbol: &str,
    options: &LookupOptions,
) -> anyhow::Result<PolygonResult<TickerDetail>> {
    let primary = polygon::get_ticker_detail(ticker_symbol, options).await;
    if !falls_back(&primary) {
        return Ok(primary);
    }
    note_fallback("getTickerDetail", ticker_symbol);
    yahoo::get_ticker_detail(ticker_symbol, options).await
}

pub async fn get_close_price_with_fallback(
    ticker_symbol: &str,
    date: JsDate,
    options: &LookupOptions,
) -> anyhow::Result<PolygonResult<f64>> {
    let primary = polygon::get_close_price(ticker_symbol, date, options).await;
    if !falls_back(&primary) {
        return Ok(primary);
    }
    note_fallback("getClosePrice", ticker_symbol);
    yahoo::get_close_price(ticker_symbol, date, options).await
}

pub async fn get_latest_close_price_on_or_before_with_fallback(
    ticker_symbol: &str,
    date_or_string: impl Into<DateOrString>,
    options: &LookupOptions,
) -> anyhow::Result<PolygonResult<Close>> {
    let date_or_string = date_or_string.into();
    let primary = polygon::get_latest_close_price_on_or_before(ticker_symbol, date_or_string.clone(), options).await?;
    if !falls_back(&primary) {
        return Ok(primary);
    }
    note_fallback("getLatestClosePriceOnOrBefore", ticker_symbol);
    yahoo::get_latest_close_price_on_or_before(ticker_symbol, date_or_string, options).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::polygon::tests::with_env;
    use crate::server::polygon::PolygonFailure;

    fn failed(error: PolygonErrorKind) -> PolygonResult<f64> {
        Err(PolygonFailure::new(error, "x"))
    }

    #[test]
    fn a_polygon_answer_is_kept_without_touching_yahoo() {
        assert!(!falls_back(&Ok(185.5)));
    }

    #[test]
    fn falls_back_to_yahoo_when_polygon_has_no_data() {
        assert!(falls_back(&failed(PolygonErrorKind::NoData)));
    }

    #[test]
    fn does_not_fall_back_when_polygon_refuses_or_errors() {
        // Only no_data is a verdict on the symbol.
        for error in [
            PolygonErrorKind::ApiError,
            PolygonErrorKind::PlanLimit,
            PolygonErrorKind::RateLimited,
            PolygonErrorKind::NoApiKey,
        ] {
            assert!(!falls_back(&failed(error)), "{}", error.as_str());
        }
    }

    #[tokio::test]
    async fn an_unconfigured_polygon_surfaces_as_is() {
        with_env(&[("POLYGON_API_KEY", None)], async {
            let options = LookupOptions::default();
            let detail = get_ticker_detail_with_fallback("VFIAX", &options).await.unwrap();
            assert_eq!(detail.unwrap_err().error, PolygonErrorKind::NoApiKey);
            let price = get_close_price_with_fallback("VFIAX", JsDate::parse("2026-10-06T12:00:00Z"), &options).await;
            assert_eq!(price.unwrap().unwrap_err().error, PolygonErrorKind::NoApiKey);
            let latest = get_latest_close_price_on_or_before_with_fallback("VFIAX", "2026-10-08", &options).await;
            assert_eq!(latest.unwrap().unwrap_err().error, PolygonErrorKind::NoApiKey);
        })
        .await;
    }
}
