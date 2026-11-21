//! `src/server/lib/postgres/repositories/holdings.ts`.

use serde_json::json;

use crate::filters;
use crate::js::{to_js_string, Json, Obj};
use crate::server::logger;
use crate::server::postgres::client::Executor;
use crate::server::postgres::database::{error_result, success_result, SearchFilters, UpsertResult};
use crate::server::postgres::models::{holding, MaskedUser};

pub async fn get_holdings(user: &MaskedUser) -> anyhow::Result<Vec<Json>> {
    let models = holding::TABLE.query(filters! { "user_id" => user.user_id.as_str() }, SearchFilters::default(), None).await?;
    Ok(models.iter().map(holding::to_json).collect())
}

/// Columns a holding conflict may rewrite. `holding_id` is derived from a
/// caller-supplied `account_id`, so without an allowlist `Table::upsert`
/// defaults to every supplied key and a colliding id reassigns the row's owner.
const HOLDING_UPDATE_COLUMNS: &[&str] = &[
    "security_id",
    "institution_price",
    "institution_price_as_of",
    "institution_value",
    "cost_basis",
    "quantity",
    "iso_currency_code",
    "raw",
];

/// Writes each holding, reporting one result per holding under its id (its
/// own, or `<account_id>-<security_id>`): a failed write is logged and
/// answers 500 for that holding alone.
pub async fn upsert_holdings(user: &MaskedUser, holdings: &[Obj]) -> Vec<UpsertResult> {
    let mut results = Vec::new();

    for holding in holdings {
        let row = holding::from_json(holding, &user.user_id);
        // The row always carries the id: `from_json` derives one where the holding has none.
        let holding_id = row.get("holding_id").map(to_js_string).unwrap_or_default();
        match holding::TABLE.upsert(&row, Some(HOLDING_UPDATE_COLUMNS), None).await {
            Ok(_) => results.push(success_result(&holding_id, Some(1))),
            Err(error) => {
                logger::error("Failed to upsert holding", Some(&crate::ctx! { "holdingId": row.get("holding_id") }), Some(&error));
                results.push(error_result(&holding_id));
            }
        }
    }
    results
}

/// One holdings row, failing when the write fails. Inside a transaction a
/// swallowed error leaves Postgres aborted, and the COMMIT that follows rolls
/// back without raising, so the caller would report a write that never
/// happened.
pub async fn upsert_holding_or_throw(user: &MaskedUser, holding: &Obj, client: Option<&dyn Executor>) -> anyhow::Result<()> {
    holding::TABLE.upsert(&holding::from_json(holding, &user.user_id), Some(HOLDING_UPDATE_COLUMNS), client).await?;
    Ok(())
}

/// Soft-deletes the user's holdings; returns how many were deleted.
pub async fn delete_holdings(user: &MaskedUser, holding_ids: &[String]) -> anyhow::Result<u64> {
    if holding_ids.is_empty() {
        return Ok(0);
    }
    // Snapshots are intentionally NOT soft-deleted. The sync path writes a
    // fresh `quantity = 0` terminator snapshot for every removed holding
    // BEFORE calling this: that terminator is the deletion signal historical
    // readers (charts, performance calculations) consume.
    let ids: Vec<Json> = holding_ids.iter().map(|holding_id| json!(holding_id)).collect();
    holding::TABLE.bulk_soft_delete(&ids, &[("user_id", json!(user.user_id))], None).await
}

pub async fn search_holdings_by_account_id(user: &MaskedUser, account_ids: &[String]) -> anyhow::Result<Vec<Json>> {
    if account_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<Json> = account_ids.iter().map(|account_id| json!(account_id)).collect();
    let models = holding::TABLE
        .query(
            filters! { "user_id" => user.user_id.as_str() },
            SearchFilters { in_filters: vec![("account_id".to_string(), ids)], ..Default::default() },
            None,
        )
        .await?;
    Ok(models.iter().map(holding::to_json).collect())
}

#[cfg(test)]
mod tests {
    use super::super::items::testing::{obj, test_user, update_columns_of, FakeExecutor};
    use super::*;

    // `holdings.test.ts`: the cases that reach no database, and the conflict
    // cases through `upsert_holding_or_throw`, which writes the same row with
    // the same allowlist as `upsert_holdings` on the executor it is given.

    #[tokio::test]
    async fn empty_input_is_a_no_op() {
        assert_eq!(delete_holdings(&test_user(), &[]).await.unwrap(), 0);
        assert!(search_holdings_by_account_id(&test_user(), &[]).await.unwrap().is_empty());
        assert!(upsert_holdings(&test_user(), &[]).await.is_empty());
    }

    async fn upsert_one(holding: Json) -> (String, Vec<Json>) {
        let client = FakeExecutor::default();
        upsert_holding_or_throw(&test_user(), &obj(holding), Some(&client)).await.unwrap();
        client.calls().remove(0)
    }

    fn position() -> Json {
        json!({
            "holding_id": "acct-A-sec-1",
            "account_id": "acct-A",
            "security_id": "sec-1",
            "quantity": 999,
            "cost_basis": 1,
            "institution_price": 1,
            "institution_price_as_of": "2026-07-01",
            "institution_value": 999,
            "iso_currency_code": "USD",
            "unofficial_currency_code": null,
        })
    }

    #[tokio::test]
    async fn a_conflict_never_reassigns_the_row_owner_or_the_account() {
        let columns = update_columns_of(&upsert_one(position()).await.0);
        assert!(!columns.is_empty());
        for column in ["user_id", "account_id", "holding_id"] {
            assert!(!columns.contains(&column.to_string()), "{column}");
        }
    }

    #[tokio::test]
    async fn a_conflict_still_rewrites_the_position() {
        let columns = update_columns_of(&upsert_one(position()).await.0);
        for column in
            ["security_id", "institution_price", "institution_price_as_of", "institution_value", "cost_basis", "quantity", "iso_currency_code"]
        {
            assert!(columns.contains(&column.to_string()), "{column}");
        }
    }

    #[tokio::test]
    async fn the_owner_is_inserted_on_a_first_write() {
        let (sql, values) = upsert_one(position()).await;
        assert!(sql.split("DO UPDATE SET").next().unwrap().contains("user_id"));
        assert_eq!(values[..2], [json!("usr-1"), json!("acct-A-sec-1")]);
    }

    #[tokio::test]
    async fn a_column_the_caller_omitted_is_left_alone_rather_than_nulled() {
        // `institution_price_as_of` is optional on a provider's holding payload,
        // so it never reaches the INSERT column list. A SET entry for it would
        // resolve `EXCLUDED` to the column default and wipe the stored date.
        let holding = json!({ "holding_id": "acct-A-sec-1", "account_id": "acct-A", "security_id": "sec-1", "quantity": 999 });
        let columns = update_columns_of(&upsert_one(holding).await.0);
        assert!(columns.contains(&"quantity".to_string()));
        assert!(!columns.contains(&"institution_price_as_of".to_string()));
        assert!(!columns.contains(&"cost_basis".to_string()));
    }

    #[tokio::test]
    async fn a_failed_write_is_an_error_not_a_result() {
        let client = FakeExecutor::failing();
        let error = upsert_holding_or_throw(&test_user(), &obj(position()), Some(&client)).await.unwrap_err();
        assert_eq!(error.to_string(), "DB unavailable");
    }
}
