//! `src/server/lib/postgres/repositories/securities.ts`.

use serde_json::json;

use crate::filters;
use crate::js::{to_js_string, Json, Obj};
use crate::server::logger;
use crate::server::postgres::client::{pool, Executor};
use crate::server::postgres::database::{error_result, success_result, Filters, SearchFilters, UpsertResult};
use crate::server::postgres::models::{security, MaskedUser};

/// Securities the user has any holding for, active or soft-deleted, so the
/// answer is scoped to the caller's portfolio rather than leaking every
/// ticker the database has ever seen.
///
/// INNER JOIN against `holdings` for the user filter; `DISTINCT` because a
/// single security can back several holdings (different accounts, historical
/// rows). Soft-deleted holdings are intentionally included so a recent unlink
/// doesn't drop the security from the client's dictionary mid-session.
pub async fn get_securities_for_user(user: &MaskedUser) -> anyhow::Result<Vec<Json>> {
    // INNER JOIN against `holdings` and DISTINCT are outside `Table::query`'s surface.
    let sql = "
    SELECT DISTINCT s.*
    FROM securities s
    INNER JOIN holdings h ON h.security_id = s.security_id
    WHERE h.user_id = ANY(sharing_user_ids($1))
  ";
    let result = pool().query(sql, &[json!(user.user_id)]).await?;
    result.rows.into_iter().map(|row| Ok(security::to_json(&security::TABLE.validate(row)?))).collect()
}

pub async fn get_security(security_id: &str) -> anyhow::Result<Option<Json>> {
    let model = security::TABLE.query_one(filters! { "security_id" => security_id }).await?;
    Ok(model.map(|model| security::to_json(&model)))
}

/// The filters of `search_securities`; one that is absent or empty is not applied.
#[derive(Clone, Debug, Default)]
pub struct SearchSecuritiesOptions {
    pub security_id: Option<String>,
    pub ticker_symbol: Option<String>,
    pub name: Option<String>,
}

/// The filters `search_securities` applies for `options`.
fn security_filters(options: SearchSecuritiesOptions) -> Filters {
    let mut filters = Filters::new();
    if let Some(security_id) = options.security_id.filter(|security_id| !security_id.is_empty()) {
        filters.extend(filters! { "security_id" => security_id });
    }
    if let Some(ticker_symbol) = options.ticker_symbol.filter(|ticker_symbol| !ticker_symbol.is_empty()) {
        filters.extend(filters! { "ticker_symbol" => ticker_symbol });
    }
    if let Some(name) = options.name.filter(|name| !name.is_empty()) {
        filters.extend(filters! { "name" => name });
    }
    filters
}

pub async fn search_securities(options: SearchSecuritiesOptions) -> anyhow::Result<Vec<Json>> {
    // `updated DESC` gives a stable pick when several rows share a ticker
    // (`security_id` is the identity, not the ticker): a caller that takes
    // the first reliably gets the most recently touched row.
    let models = security::TABLE
        .query(security_filters(options), SearchFilters { order_by: Some("updated DESC".to_string()), ..Default::default() }, None)
        .await?;
    Ok(models.iter().map(security::to_json).collect())
}

/// The securities with these ids, in the order asked; unknown ids are left out.
pub async fn search_securities_by_id(security_ids: &[String]) -> anyhow::Result<Vec<Json>> {
    let mut results = Vec::new();
    for id in security_ids {
        if let Some(security) = get_security(id).await? {
            results.push(security);
        }
    }
    Ok(results)
}

/// Writes each security, reporting one result per security: a failed write
/// is logged and answers 500 for that security alone.
pub async fn upsert_securities(securities: &[Obj]) -> Vec<UpsertResult> {
    let mut results = Vec::new();

    for security in securities {
        let security_id = security.get("security_id").map(to_js_string).unwrap_or_default();
        let row = security::from_json(security);
        match security::TABLE.upsert(&row, None, None).await {
            Ok(_) => results.push(success_result(&security_id, Some(1))),
            Err(error) => {
                logger::error("Failed to upsert security", Some(&crate::ctx! { "securityId": security.get("security_id") }), Some(&error));
                results.push(error_result(&security_id));
            }
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::postgres::database::build_select_with_filters;

    #[tokio::test]
    async fn empty_input_is_a_no_op() {
        assert!(search_securities_by_id(&[]).await.unwrap().is_empty());
        assert!(upsert_securities(&[]).await.is_empty());
    }

    fn search_sql(options: SearchSecuritiesOptions) -> (String, Vec<Json>) {
        let search = SearchFilters {
            filters: security_filters(options),
            order_by: Some("updated DESC".to_string()),
            exclude_deleted: Some(security::TABLE.supports_soft_delete),
            ..Default::default()
        };
        let query = build_select_with_filters(security::TABLE.name, "*", &search);
        (query.sql, query.values)
    }

    #[test]
    fn a_search_with_no_filter_reads_every_security_most_recently_touched_first() {
        let (sql, values) = search_sql(SearchSecuritiesOptions::default());
        assert_eq!(sql, "SELECT * FROM securities ORDER BY updated DESC");
        assert!(values.is_empty());
    }

    #[test]
    fn a_search_applies_each_filter_that_is_given_and_skips_an_empty_one() {
        let (sql, values) = search_sql(SearchSecuritiesOptions {
            security_id: Some("sec-1".to_string()),
            ticker_symbol: Some("VOO".to_string()),
            name: Some(String::new()),
        });
        assert_eq!(sql, "SELECT * FROM securities WHERE security_id = $1 AND ticker_symbol = $2 ORDER BY updated DESC");
        assert_eq!(values, vec![json!("sec-1"), json!("VOO")]);

        let (sql, values) = search_sql(SearchSecuritiesOptions { name: Some("Vanguard S&P 500 ETF".to_string()), ..Default::default() });
        assert_eq!(sql, "SELECT * FROM securities WHERE name = $1 ORDER BY updated DESC");
        assert_eq!(values, vec![json!("Vanguard S&P 500 ETF")]);
    }
}
