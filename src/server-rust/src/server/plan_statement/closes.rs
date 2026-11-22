//! The closes a restated fund is priced against:
//! `src/server/lib/plan-statement/closes.ts`.
//!
//! The answer is the TypeScript's `RestatementCloses`, as JSON:
//! `{ bars: [{ date, close, adjustedClose }] }`, or `{ message }` with
//! `retryable: true` when asking again later can succeed.

use serde_json::json;

use crate::js::Json;
use crate::server::daily_closes::{get_daily_closes, peek_daily_closes, warm_daily_closes, DailyClose, DailyClosesPeek};
use crate::server::polygon::{self, LookupOptions, PolygonErrorKind, PolygonResult};
use crate::server::postgres::models::MaskedUser;
use crate::server::rate_limit::{POLYGON_LOOKUP_RATE_LIMITER, POLYGON_LOOKUP_SHED_MESSAGE};

fn bars_of(bars: &[DailyClose]) -> Json {
    json!({ "bars": bars.iter().map(DailyClose::to_json).collect::<Vec<_>>() })
}

/// The daily closes a restated fund's rows are priced and checked against. A
/// call that would reach the shared market data gate is charged to the same
/// per-user budget the ticker lookups use. It waits only as long as any other
/// request a person is watching; past that the fetch carries on in the
/// background and the answer is "still loading", for the page to retry.
///
/// `Err` is where the TypeScript throws (see `daily_closes::get_daily_closes`).
pub async fn get_restatement_closes(user: &MaskedUser, ticker: &str, from: &str, to: &str) -> anyhow::Result<Json> {
    let still_loading =
        || json!({ "message": format!("Prices for {ticker} are still loading. Retry in a minute."), "retryable": true });
    let answer = |result: PolygonResult<Vec<DailyClose>>| match result {
        Ok(bars) => bars_of(&bars),
        Err(failure) => json!({ "message": failure.message }),
    };

    match peek_daily_closes(ticker, from, to, None) {
        Some(DailyClosesPeek::Loading) => return Ok(still_loading()),
        Some(DailyClosesPeek::Answer(peeked)) => return Ok(answer(peeked)),
        None => {}
    }

    if POLYGON_LOOKUP_RATE_LIMITER.is_limited(&user.user_id) {
        return Ok(json!({ "message": POLYGON_LOOKUP_SHED_MESSAGE }));
    }
    POLYGON_LOOKUP_RATE_LIMITER.consume(&user.user_id, 1);
    let options = LookupOptions { max_wait_ms: Some(polygon::FOREGROUND_QUEUE_WAIT_MS), ..Default::default() };
    let result = get_daily_closes(ticker, from, to, &options).await?;
    if matches!(&result, Err(failure) if failure.error == PolygonErrorKind::RateLimited) {
        warm_daily_closes(ticker, from, None);
        return Ok(still_loading());
    }
    Ok(answer(result))
}
