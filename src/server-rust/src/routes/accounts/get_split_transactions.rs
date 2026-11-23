//! `GET /split-transactions`: `src/server/routes/accounts/get-split-transactions.ts`.

use serde_json::json;

use crate::js::{Json, Obj};
use crate::server::postgres::repositories::split_transactions::{search_split_transactions, SearchSplitTransactionsOptions};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{optional_query_string, validate_fields, validation_error, FieldSpec, FieldType};

async fn get_split_transactions(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let start_date = match optional_query_string(&ctx.req, "start-date") {
        Ok(value) => value,
        Err(message) => return Ok(validation_error(message).into()),
    };
    let end_date = match optional_query_string(&ctx.req, "end-date") {
        Ok(value) => value,
        Err(message) => return Ok(validation_error(message).into()),
    };
    // The parsed `start-date`/`end-date` become TIMESTAMPTZ predicates below:
    // reject a malformed or non-calendar date here instead of letting
    // Postgres raise 22007/22008 inside the route.
    let mut dates = Obj::new();
    if let Some(start) = &start_date {
        dates.insert("start-date".into(), json!(start));
    }
    if let Some(end) = &end_date {
        dates.insert("end-date".into(), json!(end));
    }
    if let Err(message) =
        validate_fields(&dates, &[FieldSpec::new("start-date", FieldType::Date), FieldSpec::new("end-date", FieldType::Date)])
    {
        return Ok(validation_error(message).into());
    }

    let account_id = match optional_query_string(&ctx.req, "account-id") {
        Ok(value) => value,
        Err(message) => return Ok(validation_error(message).into()),
    };

    let options = SearchSplitTransactionsOptions {
        // Always return soft-deleted rows so the client can treat them as
        // tombstones and evict them from its local cache, as the snapshots
        // and transactions routes do. Direct repository callers default to
        // active-only because they don't ask for them.
        include_deleted: true,
        start_date,
        end_date,
        account_id,
        ..Default::default()
    };

    let split_transactions = search_split_transactions(&user, &options).await?;

    Ok(ApiResponse::success_with(Json::Array(split_transactions)).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/split-transactions", get_split_transactions)]
}
