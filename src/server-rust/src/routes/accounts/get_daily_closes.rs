//! `GET /daily-closes`: `src/server/routes/accounts/get-daily-closes.ts`.

use crate::common::date::is_calendar_date;
use crate::js::{Json, Obj};
use crate::server::plan_statement::get_restatement_closes;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Request, Route};
use crate::server::validation::{require_query_string, require_ticker_symbol, validation_error, Validation};

/// `GET /daily-closes?ticker=&from=YYYY-MM-DD&to=YYYY-MM-DD`
/// A public fund's daily closes, as traded and dividend-adjusted, for pricing
/// the rows of a plan statement the user marked as restated from a trust.
async fn get_daily_closes(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.user().cloned() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let ticker_param = match require_query_string(&ctx.req, "ticker") {
        Ok(ticker_param) => ticker_param,
        Err(message) => return Ok(validation_error(message).into()),
    };
    let mut named = Obj::new();
    named.insert("ticker".into(), Json::String(ticker_param));
    let ticker = match require_ticker_symbol(&named, "ticker") {
        Ok(ticker) => ticker,
        Err(message) => return Ok(validation_error(message).into()),
    };

    // `from` is checked in full before `to` is looked at.
    let from = match require_calendar_date(&ctx.req, "from") {
        Ok(from) => from,
        Err(message) => return Ok(validation_error(message).into()),
    };
    let to = match require_calendar_date(&ctx.req, "to") {
        Ok(to) => to,
        Err(message) => return Ok(validation_error(message).into()),
    };
    if from > to {
        return Ok(validation_error("from must not be after to").into());
    }

    // The lookup runs as a task of its own: a caller who hangs up mid-fetch
    // ends this handler, and the fetch must still land in memory for the next
    // ask, as it does in the Bun server, where a request's work is never cut short.
    let lookup = tokio::spawn(async move { get_restatement_closes(&user, &ticker, &from, &to).await });
    Ok(ApiResponse::success_with(lookup.await??).into())
}

/// A required query parameter that is a day on the calendar.
fn require_calendar_date(req: &Request, param: &str) -> Validation<String> {
    let value = require_query_string(req, param)?;
    if !is_calendar_date(&value) {
        return Err(format!("{param} must be a YYYY-MM-DD date"));
    }
    Ok(value)
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/daily-closes", get_daily_closes)]
}
