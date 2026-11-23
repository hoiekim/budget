//! `GET /snapshots/holding`: `src/server/routes/accounts/get-holding-snapshots.ts`.

use std::collections::HashMap;

use serde_json::json;

use crate::js::Json;
use crate::server::postgres::repositories::securities::search_securities_by_id;
use crate::server::postgres::repositories::snapshots::{get_holding_snapshots, HoldingSnapshotsOptions};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::require_query_string;

/// The holding snapshots of the user and of everyone sharing data with them,
/// optionally of one account, each with its security's ticker and name.
async fn get_holding_snapshots_route(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.session.user.clone() else {
        return Ok(ApiResponse::failed("Request user is not authenticated.").into());
    };

    let mut options = HoldingSnapshotsOptions::default();
    if let Ok(account_id) = require_query_string(&ctx.req, "account_id") {
        options.account_id = Some(account_id);
    }

    let snapshots = get_holding_snapshots(&user, options).await?;

    // Batch-fetch security info to include ticker_symbol and name.
    let mut unique_security_ids: Vec<String> = Vec::new();
    for snapshot in &snapshots {
        if let Some(id) = snapshot.get("holding_security_id").and_then(Json::as_str) {
            if !unique_security_ids.iter().any(|seen| seen == id) {
                unique_security_ids.push(id.to_string());
            }
        }
    }
    let securities = search_securities_by_id(&unique_security_ids).await?;
    let security_map: HashMap<String, Json> =
        securities.into_iter().filter_map(|security| Some((security.get("security_id")?.as_str()?.to_string(), security))).collect();

    let snapshots_with_security: Vec<Json> = snapshots
        .into_iter()
        .map(|mut snapshot| {
            let security = snapshot.get("holding_security_id").and_then(Json::as_str).and_then(|id| security_map.get(id));
            let field = |key: &str| match security.and_then(|security| security.get(key)) {
                None | Some(Json::Null) => Json::Null,
                Some(value) => value.clone(),
            };
            let (ticker_symbol, security_name) = (field("ticker_symbol"), field("name"));
            snapshot.insert("ticker_symbol".into(), ticker_symbol);
            snapshot.insert("security_name".into(), security_name);
            Json::Object(snapshot)
        })
        .collect();

    Ok(ApiResponse::success_with(json!({ "snapshots": snapshots_with_security })).into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/snapshots/holding", get_holding_snapshots_route)]
}
