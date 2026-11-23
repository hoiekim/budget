//! A SimpleFin item's sync: its accounts, holdings, securities, institutions,
//! transactions and investment transactions:
//! `src/server/lib/compute-tools/sync-simple-fin.ts`.

use std::collections::HashMap;
use std::collections::HashSet;

use serde_json::json;

use super::cash_holding::infer_cash_holdings;
use super::create_snapshots::{
    upsert_accounts_with_snapshots, upsert_and_delete_holdings_with_snapshots, upsert_securities_with_snapshots, PriceSnapshotDate,
};
use super::sync_plaid::{build_transaction_lookup_maps, find_stored_transaction};
use crate::common::date::{get_date_string, get_date_time_string, local_date};
use crate::js::{to_js_string, truthy, Json, JsDate, Obj};
use crate::server::postgres::client::with_transaction;
use crate::server::postgres::models::MaskedUser;
use crate::server::postgres::repositories::accounts::{search_accounts_by_item_id, upsert_accounts};
use crate::server::postgres::repositories::holdings::search_holdings_by_account_id;
use crate::server::postgres::repositories::institutions::upsert_institutions;
use crate::server::postgres::repositories::investment_transactions::{delete_investment_transactions, upsert_investment_transactions};
use crate::server::postgres::repositories::items::{get_user_item, upsert_items, UserItem};
use crate::server::postgres::repositories::split_transactions::delete_split_transactions_by_transaction;
use crate::server::postgres::repositories::transactions::{
    delete_transactions, search_transactions_by_account_id, upsert_transactions, SearchTransactionsByAccountIdOptions,
    TransactionDateRange,
};
use crate::server::simple_fin::{get_data, GetSimpleFinDataOptions, SimpleFinData};

fn into_obj(value: &Json) -> Obj {
    value.as_object().cloned().unwrap_or_default()
}

fn text_id<'a>(row: &'a Json, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Json::as_str)
}

/// A row's id under `key` as the text a removal names it by.
fn id_of(row: &Json, key: &str) -> String {
    match row.get(key) {
        Some(Json::String(id)) => id.clone(),
        Some(other) => to_js_string(other),
        None => "undefined".to_string(),
    }
}

/// What a SimpleFin sync fetched.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SyncSimpleFinResult {
    pub accounts: Vec<Json>,
    pub transactions: Vec<Json>,
    pub investment_transactions: Vec<Json>,
}

/// Fetches the item's data from its SimpleFin bridge and stores it: accounts
/// (investment ones with snapshots), holdings, securities and institutions,
/// then, in one transaction, the transactions, the removals and the item's
/// watermark. `None` when there is no such item.
pub async fn sync_simple_fin_data(item_id: &str) -> anyhow::Result<Option<SyncSimpleFinResult>> {
    let Some(UserItem { user, item }) = get_user_item(item_id).await? else { return Ok(None) };

    let start_date = get_start_date(&item);

    let options = GetSimpleFinDataOptions { start_date, end_date: None, account_id: None };
    let (simple_fin_data, stored_data) = futures::join!(get_data(&item, &options), get_stored_data(&user, &item, start_date));
    let (simple_fin_data, stored_data) = (simple_fin_data?, stored_data?);

    let SimpleFinData { accounts, institutions, holdings, securities, transactions, investment_transactions } = simple_fin_data;
    let StoredData {
        transactions: stored_transactions,
        investment_transactions: stored_investment_transactions,
        accounts: stored_accounts,
        holdings: stored_holdings,
    } = stored_data;

    // The translator stamps every row with the provider's memo, and the
    // upsert writes label_memo back unconditionally, so a memo the user
    // edited would be clobbered on every hourly re-sync of the 14-day
    // window. Carry the stored label forward for rows that already exist,
    // exactly like the Plaid sync; only brand-new rows take the provider memo
    // as their initial label.
    let modeled_transactions = preserve_stored_labels(&transactions, &stored_transactions);

    let removed_transactions = get_removed_transactions(&transactions, &stored_transactions, start_date);
    let removed_investment_transactions =
        get_removed_investment_transactions(&investment_transactions, &stored_investment_transactions, start_date);

    // Securities first, so the client has ticker/name rows to resolve
    // against; the cash inference and the holding upsert run once the
    // investment accounts are built, since the inference needs each
    // account's current balance. Holdings whose security was filtered out
    // (no ticker or no close price) are dropped, so no orphan reference is
    // stored.
    let securities: Vec<Obj> = securities.iter().map(into_obj).collect();
    let upserted_ids = upsert_securities_with_snapshots(&securities, PriceSnapshotDate::SyncTime).await;
    let mapped_holdings: Vec<Obj> =
        holdings.iter().filter(|h| text_id(h, "security_id").is_some_and(|id| upserted_ids.contains(id))).map(into_obj).collect();

    let mut investment_accounts: Vec<Obj> = Vec::new();
    let mut other_accounts: Vec<Obj> = Vec::new();
    let existing_accounts_map: HashMap<&str, &Json> =
        stored_accounts.iter().filter_map(|a| text_id(a, "account_id").map(|id| (id, a))).collect();
    let institution_id = item.get("institution_id").filter(|id| truthy(id)).cloned().unwrap_or_else(|| json!("unknown"));
    for a in &accounts {
        let existing = text_id(a, "account_id").and_then(|id| existing_accounts_map.get(id)).copied();
        let stored_or = |key: &str, fallback: Json| match existing.and_then(|existing| existing.get(key)) {
            Some(value) if !value.is_null() => value.clone(),
            _ => fallback,
        };
        let mut incoming_account = into_obj(a);
        incoming_account.insert("institution_id".into(), institution_id.clone());
        incoming_account.insert("item_id".into(), item.get("item_id").cloned().unwrap_or(Json::Null));
        incoming_account.insert("hide".into(), stored_or("hide", json!(false)));
        incoming_account.insert("custom_name".into(), stored_or("custom_name", json!("")));
        incoming_account.insert("label".into(), stored_or("label", json!({})));
        incoming_account.insert(
            "graphOptions".into(),
            stored_or("graphOptions", json!({ "useSnapshots": true, "useHoldingSnapshots": true, "useTransactions": true })),
        );
        if a.get("type").and_then(Json::as_str) == Some("investment") {
            investment_accounts.push(incoming_account);
        } else {
            other_accounts.push(incoming_account);
        }
    }

    // Cash inference, as in the Plaid sync: every investment account ends up
    // with a cash holding, whether SimpleFin listed one or not.
    let inferred_cash = infer_cash_holdings(&investment_accounts, &mapped_holdings, &securities).await?;
    let mut all_mapped_holdings = mapped_holdings;
    all_mapped_holdings.extend(inferred_cash);

    let stored_account_rows: Vec<Obj> = stored_accounts.iter().map(into_obj).collect();
    let stored_holding_rows: Vec<Obj> = stored_holdings.iter().map(into_obj).collect();
    let institutions: Vec<Obj> = institutions.iter().map(into_obj).collect();

    // Phase 1: idempotent writes (accounts, holdings, institutions), safe
    // outside a transaction because the next sync retries them without data
    // loss. No account_id-churn check here: SimpleFin accounts carry no mask
    // or subtype, so the (name, mask, subtype) match would degrade to a
    // name-only one, which two cards from one bank can share.
    upsert_accounts_with_snapshots(&user, &investment_accounts, &stored_account_rows).await;
    upsert_accounts(&user, &other_accounts, None).await;
    upsert_and_delete_holdings_with_snapshots(&user, &all_mapped_holdings, &stored_holding_rows).await?;
    upsert_institutions(&institutions, None).await;

    // Phase 2: the transactions and the watermark are written atomically. If
    // the process dies midway, the whole block rolls back and the watermark
    // is not advanced, so the next sync re-processes the same window safely.
    let modeled: Vec<Obj> = modeled_transactions.iter().map(into_obj).collect();
    let investments: Vec<Obj> = investment_transactions.iter().map(into_obj).collect();
    let mut updated_item = into_obj(&item);
    updated_item.insert("updated".into(), json!(get_date_string(JsDate::now())));
    let writer = user.clone();
    with_transaction(move |client| {
        Box::pin(async move {
            upsert_transactions(&writer, &modeled, Some(client)).await;
            delete_transactions(&writer, &removed_transactions, Some(client)).await?;
            for tx_id in &removed_transactions {
                delete_split_transactions_by_transaction(&writer, tx_id, Some(client)).await?;
            }
            upsert_investment_transactions(&writer, &investments, Some(client)).await;
            delete_investment_transactions(&writer, &removed_investment_transactions, Some(client)).await?;
            upsert_items(&writer, &[updated_item], Some(client)).await;
            Ok(())
        })
    })
    .await?;

    Ok(Some(SyncSimpleFinResult { accounts, transactions, investment_transactions }))
}

/// The first moment to fetch from: two weeks before the item last synced, or
/// two years back for an item that never did.
fn get_start_date(item: &Json) -> JsDate {
    match item.get("updated").filter(|updated| truthy(updated)) {
        Some(updated) => {
            let updated_date = match updated {
                Json::String(text) => local_date(&get_date_time_string(text)),
                other => JsDate::from_json(other),
            };
            updated_date.set_date(updated_date.get_date() - 14)
        }
        None => {
            let oldest_date = JsDate::now();
            oldest_date.set_full_year(JsDate::now().get_full_year() - 2)
        }
    }
}

/// The rows the sync compares against.
struct StoredData {
    accounts: Vec<Json>,
    holdings: Vec<Json>,
    transactions: Vec<Json>,
    investment_transactions: Vec<Json>,
}

async fn get_stored_data(user: &MaskedUser, item: &Json, start_date: JsDate) -> anyhow::Result<StoredData> {
    let item_id = item.get("item_id").map(|id| id.as_str().map(str::to_string).unwrap_or_else(|| to_js_string(id))).unwrap_or_default();
    let accounts = search_accounts_by_item_id(user, &item_id).await?;
    let account_ids: Vec<String> = accounts.iter().filter_map(|e| text_id(e, "account_id").map(str::to_string)).collect();

    let range = TransactionDateRange { start: Some(start_date), end: Some(JsDate::now()) };
    let options = SearchTransactionsByAccountIdOptions::default();

    let (holdings, transactions_data) = futures::join!(
        search_holdings_by_account_id(user, &account_ids),
        search_transactions_by_account_id(user, &account_ids, &range, &options),
    );
    let (holdings, transactions_data) = (holdings?, transactions_data?);

    Ok(StoredData {
        accounts,
        holdings,
        transactions: transactions_data.transactions,
        investment_transactions: transactions_data.investment_transactions,
    })
}

/// Carries the stored label forward onto re-synced SimpleFin transactions.
/// Rows that already exist keep their stored label (a memo the user edited
/// included); rows with no stored match are left as translated, so the
/// provider's memo becomes their initial label. The id-based lookup follows
/// pending→posted id changes the way the Plaid sync does.
pub fn preserve_stored_labels(transactions: &[Json], stored_transactions: &[Json]) -> Vec<Json> {
    let lookup_maps = build_transaction_lookup_maps(stored_transactions);
    transactions
        .iter()
        .map(|t| match find_stored_transaction(t, &lookup_maps) {
            Some(existing) => {
                let mut carried = into_obj(t);
                match existing.get("label") {
                    Some(label) => carried.insert("label".into(), label.clone()),
                    None => carried.shift_remove("label"),
                };
                Json::Object(carried)
            }
            None => t.clone(),
        })
        .collect()
}

/// `new LocalDate(date) < startDate`.
fn is_before(row: &Json, start_date: JsDate) -> bool {
    let date = match row.get("date") {
        Some(Json::String(text)) => local_date(text),
        Some(other) => JsDate::from_json(other),
        None => JsDate::from_ms(f64::NAN),
    };
    date.get_time() < start_date.get_time()
}

/// The stored rows `incoming` no longer lists: those in the window, of an
/// account the bridge answered for, that are not user-entered (the sync must
/// never remove those) and whose id `key` is missing from `incoming`.
fn removed_rows(incoming: &[Json], stored: &[Json], start_date: JsDate, key: &str) -> Vec<String> {
    let account_ids: HashSet<String> = incoming.iter().map(|e| id_of(e, "account_id")).collect();
    let ids: HashSet<String> = incoming.iter().map(|e| id_of(e, key)).collect();
    let mut removed = Vec::new();
    for t in stored {
        if text_id(t, "source") == Some("manual") {
            continue;
        }
        if is_before(t, start_date) {
            continue;
        }
        if !account_ids.contains(&id_of(t, "account_id")) {
            continue;
        }
        let id = id_of(t, key);
        if !ids.contains(&id) {
            removed.push(id);
        }
    }
    removed
}

/// The ids of the stored transactions the bridge no longer lists.
pub fn get_removed_transactions(transactions: &[Json], stored_transactions: &[Json], start_date: JsDate) -> Vec<String> {
    removed_rows(transactions, stored_transactions, start_date, "transaction_id")
}

/// The ids of the stored investment transactions the bridge no longer lists.
pub fn get_removed_investment_transactions(
    investment_transactions: &[Json],
    stored_investment_transactions: &[Json],
    start_date: JsDate,
) -> Vec<String> {
    removed_rows(investment_transactions, stored_investment_transactions, start_date, "investment_transaction_id")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(base: Json, overrides: Json) -> Json {
        let mut base = base;
        for (key, value) in overrides.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    }

    fn tx(overrides: Json) -> Json {
        with(
            json!({
                "transaction_id": "tx-default",
                "account_id": "acc-1",
                "date": "2026-01-15",
                "name": "Test",
                "amount": 10,
                "pending_transaction_id": null,
                "authorized_date": null,
                "authorized_datetime": null,
                "datetime": null,
            }),
            overrides,
        )
    }

    fn inv(overrides: Json) -> Json {
        with(json!({ "investment_transaction_id": "inv-default", "account_id": "acc-1", "date": "2026-01-15" }), overrides)
    }

    fn start() -> JsDate {
        JsDate::parse("2026-01-01")
    }

    fn sorted(mut ids: Vec<String>) -> Vec<String> {
        ids.sort();
        ids
    }

    // getRemovedTransactions

    #[test]
    fn stored_transactions_still_listed_are_not_removed() {
        let incoming = [tx(json!({ "transaction_id": "tx-1" }))];
        assert_eq!(get_removed_transactions(&incoming, &[tx(json!({ "transaction_id": "tx-1" }))], start()), Vec::<String>::new());
        assert_eq!(get_removed_transactions(&incoming, &[], start()), Vec::<String>::new());
    }

    #[test]
    fn stored_transactions_no_longer_listed_are_removed() {
        let incoming = [tx(json!({ "transaction_id": "tx-1" }))];
        let stored = [tx(json!({ "transaction_id": "tx-1" })), tx(json!({ "transaction_id": "tx-2" })), tx(json!({ "transaction_id": "tx-3" }))];
        assert_eq!(sorted(get_removed_transactions(&incoming, &stored, start())), ["tx-2", "tx-3"]);
    }

    #[test]
    fn manual_rows_rows_before_the_window_and_rows_of_other_accounts_are_kept() {
        let incoming = [tx(json!({ "transaction_id": "tx-1", "account_id": "acc-1" }))];
        let stored = [
            tx(json!({ "transaction_id": "tx-1" })),
            tx(json!({ "transaction_id": "manual-1", "source": "manual" })),
            tx(json!({ "transaction_id": "tx-old", "date": "2025-12-31" })),
            tx(json!({ "transaction_id": "tx-2", "account_id": "acc-2" })),
        ];
        assert_eq!(get_removed_transactions(&incoming, &stored, start()), Vec::<String>::new());
        assert_eq!(get_removed_transactions(&[], &stored[2..3], start()), Vec::<String>::new());
    }

    // getRemovedInvestmentTransactions

    #[test]
    fn stored_investment_transactions_no_longer_listed_are_removed() {
        let incoming = [inv(json!({ "investment_transaction_id": "inv-1" }))];
        let stored = [
            inv(json!({ "investment_transaction_id": "inv-1" })),
            inv(json!({ "investment_transaction_id": "inv-2" })),
            inv(json!({ "investment_transaction_id": "inv-3" })),
        ];
        assert_eq!(sorted(get_removed_investment_transactions(&incoming, &stored, start())), ["inv-2", "inv-3"]);
        assert_eq!(get_removed_investment_transactions(&incoming, &stored[..1], start()), Vec::<String>::new());
        assert_eq!(get_removed_investment_transactions(&incoming, &[], start()), Vec::<String>::new());
    }

    #[test]
    fn manual_old_and_other_account_investment_transactions_are_kept() {
        let incoming = [inv(json!({ "investment_transaction_id": "inv-1" }))];
        let stored = [
            inv(json!({ "investment_transaction_id": "inv-1" })),
            inv(json!({ "investment_transaction_id": "manual-1", "source": "manual" })),
            inv(json!({ "investment_transaction_id": "inv-old", "date": "2025-12-31" })),
            inv(json!({ "investment_transaction_id": "inv-2", "account_id": "acc-2" })),
        ];
        assert_eq!(get_removed_investment_transactions(&incoming, &stored, start()), Vec::<String>::new());
    }

    // preserveStoredLabels

    #[test]
    fn a_re_synced_row_keeps_its_whole_stored_label_and_its_fresh_fields() {
        let incoming = [tx(json!({ "transaction_id": "tx-1", "amount": 42, "label": { "memo": "PROVIDER MEMO" } }))];
        let stored = [tx(json!({
            "transaction_id": "tx-1",
            "amount": 10,
            "label": { "memo": "mine", "category_id": "cat-9", "category_confidence": 1.0 },
        }))];
        let modeled = preserve_stored_labels(&incoming, &stored);
        assert_eq!(modeled[0]["label"], json!({ "memo": "mine", "category_id": "cat-9", "category_confidence": 1.0 }));
        assert_eq!(modeled[0]["amount"], json!(42));
    }

    #[test]
    fn a_brand_new_row_keeps_the_provider_memo() {
        let incoming = [tx(json!({ "transaction_id": "tx-new", "label": { "memo": "PROVIDER MEMO" } }))];
        assert_eq!(preserve_stored_labels(&incoming, &[])[0]["label"], json!({ "memo": "PROVIDER MEMO" }));
    }

    #[test]
    fn a_posted_row_takes_the_label_of_the_stored_pending_row() {
        let incoming = [tx(json!({ "transaction_id": "POST-1", "pending_transaction_id": "P-1", "label": { "memo": "PROVIDER MEMO" } }))];
        let stored = [tx(json!({ "transaction_id": "P-1", "label": { "memo": "labeled while pending" } }))];
        assert_eq!(preserve_stored_labels(&incoming, &stored)[0]["label"], json!({ "memo": "labeled while pending" }));
    }

    #[test]
    fn the_window_starts_two_weeks_before_the_last_sync_or_two_years_back() {
        let start = get_start_date(&json!({ "updated": "2026-01-20T12:00:00.000Z" }));
        assert_eq!(start.get_time(), JsDate::parse("2026-01-06T12:00:00.000Z").get_time());
        let never = get_start_date(&json!({}));
        assert_eq!(never.get_full_year(), JsDate::now().get_full_year() - 2);
    }
}
