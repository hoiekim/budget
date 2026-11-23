//! `GET /snapshots`: `src/server/routes/accounts/get-snapshots.ts`.

use serde_json::json;

use crate::js::{Json, Obj};
use crate::server::postgres::models::snapshot::SnapshotType;
use crate::server::postgres::repositories::snapshots::{search_snapshots, SearchSnapshotsOptions};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, JsonStream, Reply, Route, StreamNode};
use crate::server::validation::{optional_query_string, validate_fields, validation_error, FieldSpec, FieldType};

const SNAPSHOT_TYPES: [&str; 3] = ["account_balance", "holding", "security"];

/// The snapshots the query asks for, streamed one batch at a time.
async fn get_snapshots(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let start_date = match optional_query_string(&ctx.req, "start-date") {
        Ok(start_date) => start_date,
        Err(message) => return Ok(validation_error(message).into()),
    };
    let end_date = match optional_query_string(&ctx.req, "end-date") {
        Ok(end_date) => end_date,
        Err(message) => return Ok(validation_error(message).into()),
    };
    // The dates become TIMESTAMPTZ predicates: a malformed or non-calendar
    // date is refused here instead of failing inside Postgres.
    let mut dates = Obj::new();
    if let Some(start_date) = &start_date {
        dates.insert("start-date".into(), json!(start_date));
    }
    if let Some(end_date) = &end_date {
        dates.insert("end-date".into(), json!(end_date));
    }
    let date_specs = [FieldSpec::new("start-date", FieldType::Date), FieldSpec::new("end-date", FieldType::Date)];
    if let Err(message) = validate_fields(&dates, &date_specs) {
        return Ok(validation_error(message).into());
    }

    let account_id = match optional_query_string(&ctx.req, "account-id") {
        Ok(account_id) => account_id,
        Err(message) => return Ok(validation_error(message).into()),
    };
    let security_id = match optional_query_string(&ctx.req, "security-id") {
        Ok(security_id) => security_id,
        Err(message) => return Ok(validation_error(message).into()),
    };
    let snapshot_type = match optional_query_string(&ctx.req, "snapshot-type") {
        Ok(snapshot_type) => snapshot_type,
        Err(message) => return Ok(validation_error(message).into()),
    };
    let snapshot_type = match snapshot_type {
        None => None,
        Some(text) => match SnapshotType::parse(&text) {
            Some(snapshot_type) => Some(snapshot_type),
            None => return Ok(validation_error(format!("snapshot-type must be one of: {}", SNAPSHOT_TYPES.join(", "))).into()),
        },
    };

    let options = SearchSnapshotsOptions {
        // Soft-deleted rows come along as tombstones so the client can evict
        // them from its local cache: its persistence is additive and never
        // drops a row a fetch leaves out.
        include_deleted: true,
        start_date,
        end_date,
        account_id,
        security_id,
        snapshot_type,
        ..Default::default()
    };

    Ok(Reply::Stream(JsonStream {
        root: StreamNode::Object(vec![
            ("status".into(), StreamNode::Value(Json::String("success".into()))),
            ("body".into(), StreamNode::Batches(search_snapshots(Some(&user), options))),
        ]),
    }))
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/snapshots", get_snapshots)]
}
