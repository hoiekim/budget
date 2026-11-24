//! `GET /transactions`: `src/server/routes/accounts/get-transactions.ts`.

use serde_json::json;

use crate::js::Obj;
use crate::server::postgres::repositories::transactions::{search_transactions, SearchTransactionsOptions};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, JsonStream, Reply, Route, StreamNode};
use crate::server::validation::{optional_query_string, validate_fields, validation_error, FieldSpec, FieldType};

/// The user's transactions and investment transactions, streamed one batch at
/// a time so a large history is never held whole.
async fn get_transactions(ctx: &mut Ctx) -> HandlerResult {
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

    let options = SearchTransactionsOptions {
        // Always return soft-deleted rows so the client can treat them as
        // tombstones and evict them from its local cache, as the snapshots
        // route does. Direct repository callers (the engine, the Plaid delta
        // sync) still default to active-only because they don't ask for them.
        include_deleted: true,
        start_date,
        end_date,
        account_id,
        ..Default::default()
    };

    let batches = search_transactions(&user, &options);

    Ok(Reply::Stream(JsonStream::success(vec![
        ("transactions".into(), StreamNode::Batches(batches.transactions)),
        ("investmentTransactions".into(), StreamNode::Batches(batches.investment_transactions)),
    ])))
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/transactions", get_transactions)]
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use indexmap::IndexMap;
    use tokio_util::sync::CancellationToken;

    use super::super::*;
    use crate::server::route::{ApiResponse, Ctx, Reply, Request, Session};

    /// A request that reached a handler with no one signed in. The HTTP layer
    /// refuses such a request before any of these handlers runs, so only a
    /// unit test reaches their own guard.
    fn anonymous(method: &str, path: &str) -> Ctx {
        Ctx {
            req: Request {
                method: method.to_string(),
                path: path.to_string(),
                url: format!("http://localhost/api{path}"),
                headers: HashMap::new(),
                query: IndexMap::new(),
                body: Some(serde_json::json!({})),
                raw_body: None,
                ip: "127.0.0.1".to_string(),
                disconnected: CancellationToken::new(),
                idle_timeout: Default::default(),
            },
            session: Session { id: "session".into(), user: None, auth: None, destroyed: false, stored: false, bearer: false },
            status: 200,
        }
    }

    #[tokio::test]
    async fn every_transaction_route_refuses_a_session_without_a_user() {
        let routes: Vec<Route> = [
            get_transactions::routes(),
            post_transaction::routes(),
            delete_transaction::routes(),
            get_new_transaction::routes(),
            get_split_transactions::routes(),
            post_split_transaction::routes(),
            delete_split_transaction::routes(),
            get_new_split_transaction::routes(),
            post_investment_transaction::routes(),
            delete_investment_transaction::routes(),
            get_new_investment_transaction::routes(),
            post_suggest_category::routes(),
        ]
        .into_iter()
        .flatten()
        .collect();
        assert_eq!(routes.len(), 12);
        for route in routes {
            let mut ctx = anonymous(route.method, route.path);
            match route.execute(&mut ctx).await {
                Reply::Api(response) => {
                    assert_eq!(response, ApiResponse::failed("Request user is not authenticated."), "{} {}", route.method, route.path)
                }
                _ => panic!("{} {} answered something else", route.method, route.path),
            }
            assert_eq!(ctx.status, 200);
        }
    }

    #[test]
    fn only_suggest_category_takes_an_api_key() {
        let scopes: Vec<(&str, Option<&str>)> =
            [post_suggest_category::routes(), post_transaction::routes(), get_transactions::routes()]
                .into_iter()
                .flatten()
                .map(|route| (route.path, route.required_scope))
                .collect();
        assert_eq!(
            scopes,
            vec![("/suggest-category", Some("transactions:suggest")), ("/transaction", None), ("/transactions", None)]
        );
    }
}
