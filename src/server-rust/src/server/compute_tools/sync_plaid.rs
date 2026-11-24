//! A Plaid item's sync: its accounts, holdings and securities, and its
//! transactions and investment transactions: `src/server/lib/compute-tools/sync-plaid.ts`.

use std::collections::{HashMap, HashSet};

use futures::FutureExt;
use serde_json::json;

use super::cash_holding::infer_cash_holdings;
use super::create_snapshots::{
    upsert_accounts_with_snapshots, upsert_and_delete_holdings_with_snapshots, upsert_securities_with_snapshots, PriceSnapshotDate,
};
use crate::common::date::{get_date_string, get_date_time_string, local_date, TWO_WEEKS};
use crate::js::{to_js_string, truthy, truthy_opt, Json, JsDate, Obj};
use crate::server::alarm::send_alarm;
use crate::server::logger;
use crate::server::plaid::accounts::{get_accounts, get_holdings};
use crate::server::plaid::transactions::{get_investment_transactions, get_transactions};
use crate::server::plaid::util::in_call_order;
use crate::server::plaid::{PlaidHoldingsResponse, PlaidInvestmentTransactionsResponse, PlaidTransactionsResponse};
use crate::server::postgres::models::MaskedUser;
use crate::server::postgres::repositories::accounts::search_accounts_by_item_id;
use crate::server::postgres::repositories::holdings::search_holdings_by_account_id;
use crate::server::postgres::repositories::investment_transactions::{delete_investment_transactions, upsert_investment_transactions};
use crate::server::postgres::repositories::items::{get_user_item, upsert_items, UserItem};
use crate::server::postgres::repositories::rejected_categories::migrate_rejected_categories_on_pending_posted;
use crate::server::postgres::repositories::split_transactions::{
    delete_split_transactions_by_transaction, repoint_split_transactions_on_pending_posted,
};
use crate::server::postgres::repositories::transactions::{
    delete_transactions, search_transactions_by_account_id, upsert_transactions, AccountTransactions,
    SearchTransactionsByAccountIdOptions, TransactionDateRange,
};

/// `Products.Transactions` and `Products.Investments`.
const TRANSACTIONS: &str = "transactions";
const INVESTMENTS: &str = "investments";

/// The provider a Plaid item is stored under.
const PLAID: &str = "plaid";

/// The id of a stored or incoming row under `key`, when it is text: the key
/// a `Map` of rows finds it by. Rows read back from the database always
/// carry text ids.
fn text_id<'a>(row: &'a Json, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Json::as_str)
}

/// `String(value)` as a template literal writes it; `undefined` when absent.
fn interpolate(value: Option<&Json>) -> String {
    value.map(to_js_string).unwrap_or_else(|| "undefined".to_string())
}

/// `a === b` between two values that may be `undefined`.
fn strictly_equal(a: Option<&Json>, b: Option<&Json>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Json::Number(a)), Some(Json::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(a @ (Json::Null | Json::Bool(_) | Json::String(_))), Some(b)) => a == b,
        // Two objects are never the same object.
        _ => false,
    }
}

fn into_obj(value: &Json) -> Obj {
    value.as_object().cloned().unwrap_or_default()
}

/// O(n) lookups into the stored transactions, so matching each incoming
/// transaction is not a scan of every stored one.
#[derive(Debug, Default)]
pub struct TransactionLookupMaps<'a> {
    pub by_transaction_id: HashMap<&'a str, &'a Json>,
    pub by_pending_id: HashMap<&'a str, &'a Json>,
}

/// Indexes the stored transactions by `transaction_id`, and by
/// `pending_transaction_id` where they have one. A later row wins a key, as
/// in a `Map`.
pub fn build_transaction_lookup_maps(stored_transactions: &[Json]) -> TransactionLookupMaps<'_> {
    let mut maps = TransactionLookupMaps::default();
    for f in stored_transactions {
        if let Some(id) = text_id(f, "transaction_id") {
            maps.by_transaction_id.insert(id, f);
        }
        if let Some(pending) = text_id(f, "pending_transaction_id").filter(|id| !id.is_empty()) {
            maps.by_pending_id.insert(pending, f);
        }
    }
    maps
}

/// A pending transaction superseded by its posted one: Plaid's posted row
/// names the pending one in `pending_transaction_id`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingPostedTransition {
    pub pending: String,
    pub posted: String,
}

/// Detects pending→posted transitions across a batch of incoming Plaid
/// transactions, for the migrations that must follow the id rename (the
/// `rejected_categories` rows and the `split_transactions` rows).
///
/// The posted transaction's `pending_transaction_id` back-pointer is the
/// canonical supersession signal from Plaid, so nothing is cross-checked
/// against the stored set. The migrations are idempotent and do nothing when
/// the pending side has no rows, so an orphan back-pointer is harmless.
pub fn detect_pending_posted_transitions<'a>(incoming: impl IntoIterator<Item = &'a Json>) -> Vec<PendingPostedTransition> {
    let mut transitions = Vec::new();
    for e in incoming {
        let pending = e.get("pending_transaction_id");
        let posted = e.get("transaction_id");
        // Plaid's ids are text; a back-pointer that is not cannot name a stored row.
        if let (Some(Json::String(pending)), Some(Json::String(posted))) = (pending, posted) {
            if !pending.is_empty() && pending != posted {
                transitions.push(PendingPostedTransition { pending: pending.clone(), posted: posted.clone() });
            }
        }
    }
    transitions
}

/// A provider re-issued an `account_id` for an account that already exists on
/// the item: same (name, mask, subtype), new id. The old row goes stale until
/// someone notices; the new row starts with no history.
#[derive(Clone, Debug, PartialEq)]
pub struct AccountIdChurn {
    pub item_id: Option<Json>,
    pub old_account_id: Option<Json>,
    pub new_account_id: Option<Json>,
    pub name: Option<Json>,
    /// `None` when the incoming account has no `mask` at all.
    pub mask: Option<Json>,
    pub subtype: Option<Json>,
}

/// `value.toLowerCase()`, failing where JavaScript throws for a name that is not text.
fn lower_case_name(value: Option<&Json>, expression: &str) -> anyhow::Result<String> {
    match value {
        Some(Json::String(text)) => Ok(text.to_lowercase()),
        None => anyhow::bail!("undefined is not an object (evaluating '{expression}.toLowerCase')"),
        Some(Json::Null) => anyhow::bail!("null is not an object (evaluating '{expression}.toLowerCase')"),
        Some(_) => anyhow::bail!(
            "{expression}.toLowerCase is not a function. (In '{expression}.toLowerCase()', '{expression}.toLowerCase' is undefined)"
        ),
    }
}

/// Finds re-issued account ids. Deliberately matches on all three of name
/// (case-insensitive), mask and subtype, never on the name alone: two cards
/// from the same bank can legitimately share a name.
///
/// Only incoming ids absent from the stored set are candidates: once the new
/// id is upserted, later syncs see it as known, so a pair fires on the sync
/// where it first appears and never again. When several stored accounts
/// match, the live (non-archived) one is the predecessor, since the archived
/// ones are already dead ends; if every match is archived, each is reported,
/// because the true predecessor is unknowable from these fields.
pub fn detect_account_id_churn(incoming: &[Obj], stored: &[Json]) -> anyhow::Result<Vec<AccountIdChurn>> {
    let stored_ids: Vec<Option<&Json>> = stored.iter().map(|s| s.get("account_id")).collect();
    let mut churn = Vec::new();
    for account in incoming {
        if stored_ids.iter().any(|id| strictly_equal(*id, account.get("account_id"))) {
            continue;
        }
        let mut siblings: Vec<&Json> = Vec::new();
        for s in stored {
            if !strictly_equal(s.get("item_id"), account.get("item_id")) {
                continue;
            }
            let same_name = lower_case_name(s.get("name"), "s.name")? == lower_case_name(account.get("name"), "account.name")?;
            if same_name && strictly_equal(s.get("mask"), account.get("mask")) && strictly_equal(s.get("subtype"), account.get("subtype")) {
                siblings.push(s);
            }
        }
        let live: Vec<&Json> = siblings.iter().copied().filter(|s| !truthy_opt(s.get("archived"))).collect();
        let candidates = if live.is_empty() { siblings } else { live };
        for sibling in candidates {
            churn.push(AccountIdChurn {
                item_id: account.get("item_id").cloned(),
                old_account_id: sibling.get("account_id").cloned(),
                new_account_id: account.get("account_id").cloned(),
                name: account.get("name").cloned(),
                mask: account.get("mask").cloned(),
                subtype: account.get("subtype").cloned(),
            });
        }
    }
    Ok(churn)
}

/// `value ?? "null"` in a template literal.
fn or_null(value: Option<&Json>) -> String {
    match value {
        None | Some(Json::Null) => "null".to_string(),
        Some(value) => to_js_string(value),
    }
}

/// Logs a warning with the three ids and the matched attributes for each
/// re-issued account id, and alarms on the channel of the other sync alarms.
/// The alarm key is per pair, so the same churn cannot spam within the
/// cooldown window. The alarms are sent in the background; the sync does not
/// wait on them.
pub fn report_account_id_churn(incoming: &[Obj], stored: &[Json]) -> anyhow::Result<()> {
    for c in detect_account_id_churn(incoming, stored)? {
        let mut context = Obj::new();
        for (key, value) in [
            ("itemId", &c.item_id),
            ("oldAccountId", &c.old_account_id),
            ("newAccountId", &c.new_account_id),
            ("name", &c.name),
            ("mask", &c.mask),
            ("subtype", &c.subtype),
        ] {
            if let Some(value) = value {
                context.insert(key.into(), value.clone());
            }
        }
        logger::warn("Provider re-issued account_id for an existing account", Some(&context), None);
        let detail = format!(
            "**Item:** {}\n**Old account_id:** {}\n**New account_id:** {}\n**Name:** {}\n**Mask:** {}\n**Subtype:** {}",
            interpolate(c.item_id.as_ref()),
            interpolate(c.old_account_id.as_ref()),
            interpolate(c.new_account_id.as_ref()),
            interpolate(c.name.as_ref()),
            or_null(c.mask.as_ref()),
            or_null(c.subtype.as_ref()),
        );
        let key = format!("account-id-churn:{}:{}", interpolate(c.old_account_id.as_ref()), interpolate(c.new_account_id.as_ref()));
        tokio::spawn(async move { send_alarm("Account ID churn detected", &detail, Some(&key), false).await });
    }
    Ok(())
}

/// Finds the stored transaction whose label carries forward to an incoming
/// Plaid transaction. Three id-based lookups in order of authority, and no
/// attribute-based (name/amount) fallback:
///
///  1. The same `transaction_id`: Plaid re-serving the same row.
///  2. The incoming `pending_transaction_id` as a stored `transaction_id`:
///     the canonical pending→posted transition, which keeps the label the
///     user set on the pending row.
///  3. A stored row whose `pending_transaction_id` is the incoming id: the
///     mirror image, where a stored posted row points back at an id Plaid
///     then re-serves as pending. Rare, but keeps the reconciliation symmetric.
pub fn find_stored_transaction<'a>(incoming: &Json, maps: &TransactionLookupMaps<'a>) -> Option<&'a Json> {
    let incoming_id = text_id(incoming, "transaction_id");
    if let Some(found) = incoming_id.and_then(|id| maps.by_transaction_id.get(id)) {
        return Some(found);
    }
    if let Some(pending) = incoming.get("pending_transaction_id").filter(|pending| truthy(pending)) {
        if let Some(found) = pending.as_str().and_then(|id| maps.by_transaction_id.get(id)) {
            return Some(found);
        }
    }
    incoming_id.and_then(|id| maps.by_pending_id.get(id)).copied()
}

/// Milliseconds from the local midnight of a stored row's `date` to now.
fn age_of(row: &Json) -> f64 {
    let date = match row.get("date") {
        Some(Json::String(text)) => local_date(text),
        Some(value) => JsDate::from_json(value),
        None => JsDate::from_ms(f64::NAN),
    };
    JsDate::now_ms() - date.get_time()
}

/// The ids of recently stored investment transactions (two weeks back) that
/// the incoming list no longer has. A user-entered row is never one: it can
/// live on a Plaid brokerage (RSU/ESPP) without ever appearing in Plaid's list.
pub fn get_plaid_removed_investment_transactions(incoming_transactions: &[Json], stored_transactions: &[Json]) -> Vec<String> {
    let incoming_ids: HashSet<&str> = incoming_transactions.iter().filter_map(|f| text_id(f, "investment_transaction_id")).collect();
    let mut removed = Vec::new();
    for e in stored_transactions {
        if text_id(e, "source") == Some("manual") {
            continue;
        }
        if age_of(e) > TWO_WEEKS {
            continue;
        }
        let id = text_id(e, "investment_transaction_id");
        if !id.is_some_and(|id| incoming_ids.contains(id)) {
            removed.push(id.map(str::to_string).unwrap_or_else(|| interpolate(e.get("investment_transaction_id"))));
        }
    }
    removed
}

/// `item.available_products.includes(product)`, failing where JavaScript
/// throws for an item whose products are not a list.
fn has_product(item: &Json, product: &str) -> anyhow::Result<bool> {
    match item.get("available_products") {
        Some(Json::Array(products)) => Ok(products.iter().any(|p| p.as_str() == Some(product))),
        Some(Json::String(text)) => Ok(text.contains(product)),
        None => anyhow::bail!("undefined is not an object (evaluating 'item.available_products.includes')"),
        Some(Json::Null) => anyhow::bail!("null is not an object (evaluating 'item.available_products.includes')"),
        Some(_) => anyhow::bail!(
            "item.available_products.includes is not a function. (In 'item.available_products.includes(Products.{}s)', 'item.available_products.includes' is undefined)",
            if product == TRANSACTIONS { "Transaction" } else { "Investment" }
        ),
    }
}

/// `getDateTimeString(value)` on a date Plaid sent, failing where JavaScript
/// throws for one that is not text.
fn date_time_string(value: &Json) -> anyhow::Result<Json> {
    match value {
        Json::String(text) => Ok(json!(get_date_time_string(text))),
        _ => anyhow::bail!("dateString.includes is not a function. (In 'dateString.includes(\"T\")', 'dateString.includes' is undefined)"),
    }
}

/// What a transactions sync changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncTransactionsResult {
    pub user_id: String,
    pub added: i64,
    pub modified: i64,
    pub removed: i64,
}

/// The first day of the window to compare against: a month before the item
/// last synced, or two years back for an item that never did.
fn transactions_start_date(item: &Json) -> JsDate {
    let updated = item.get("updated").filter(|updated| truthy(updated)).map(|updated| match updated {
        Json::String(text) => local_date(text),
        other => JsDate::from_json(other),
    });
    match updated {
        Some(updated) => {
            let date = if updated.is_valid() { updated } else { JsDate::now() };
            date.set_month(date.get_month() - 1)
        }
        None => {
            let now = JsDate::now();
            now.set_full_year(JsDate::now().get_full_year() - 2)
        }
    }
}

/// Fetches the item's transactions and investment transactions from Plaid and
/// stores them: new and changed rows, removals, pending→posted migrations,
/// and the item's cursor and watermark. `None` when there is no such Plaid item.
///
/// Both are fetched and stored at once, as in the TypeScript, with the Plaid
/// calls taking turns in the order they are asked for (`in_call_order`): the
/// first transactions page, the investment transactions, then the next
/// transactions pages, which is the order they reach Plaid there.
pub async fn sync_plaid_transactions(item_id: &str) -> anyhow::Result<Option<SyncTransactionsResult>> {
    sync_plaid_transactions_of(item_id, get_user_item(item_id).await).await
}

/// [`sync_plaid_transactions`] of an item already read: `read` is what
/// [`get_user_item`] answered for `item_id`.
pub async fn sync_plaid_transactions_of(
    item_id: &str,
    read: anyhow::Result<Option<UserItem>>,
) -> anyhow::Result<Option<SyncTransactionsResult>> {
    let Some(UserItem { user, item }) = read? else { return Ok(None) };
    if item.get("provider").and_then(Json::as_str) != Some(PLAID) {
        return Ok(None);
    }

    let accounts = search_accounts_by_item_id(&user, item_id).await?;
    let account_ids: Vec<String> = accounts.iter().filter_map(|e| text_id(e, "account_id").map(str::to_string)).collect();

    let range = TransactionDateRange { start: Some(transactions_start_date(&item)), end: Some(JsDate::now()) };

    let sync_transactions = has_product(&item, TRANSACTIONS)?;
    let sync_investment_transactions = has_product(&item, INVESTMENTS)?;

    let items = [item.clone()];
    // Read once, while Plaid is asked, by whichever branch needs it first; a
    // failed read fails each branch that waits on it.
    let stored = async {
        search_transactions_by_account_id(&user, &account_ids, &range, &SearchTransactionsByAccountIdOptions { include_deleted: true })
            .await
            .map_err(|error| error.to_string())
    }
    .shared();
    let stored_rows = || async { stored.clone().await.map_err(|message| anyhow::anyhow!("{message}")) };

    let transactions_branch = async {
        if !sync_transactions {
            return anyhow::Ok(Counts::default());
        }
        let fetched = get_transactions(&user, &items).await?;
        let stored = stored_rows().await?;
        store_transactions(&user, item_id, fetched, &stored).await
    };
    let investments_branch = async {
        if !sync_investment_transactions {
            return anyhow::Ok(Counts::default());
        }
        let fetched = get_investment_transactions(&user, &items).await?;
        let stored = stored_rows().await?;
        store_investment_transactions(&user, item_id, fetched, &stored).await
    };
    let (_, transactions_counts, investments_counts) =
        in_call_order(async { futures::join!(stored.clone(), transactions_branch, investments_branch) }).await;
    let (transactions_counts, investments_counts) = (transactions_counts?, investments_counts?);

    Ok(Some(SyncTransactionsResult {
        user_id: user.user_id.clone(),
        added: transactions_counts.added + investments_counts.added,
        modified: transactions_counts.modified + investments_counts.modified,
        removed: transactions_counts.removed + investments_counts.removed,
    }))
}

/// What one branch of a transactions sync adds to the counts.
#[derive(Clone, Copy, Debug, Default)]
struct Counts {
    added: i64,
    modified: i64,
    removed: i64,
}

/// `{ ...e, label: {} }` with its dates as date-times, carrying forward the
/// label of the stored transaction it continues.
fn modelize(e: &Json, maps: &TransactionLookupMaps<'_>) -> anyhow::Result<Obj> {
    let mut result = into_obj(e);
    result.insert("label".into(), json!({}));
    if let Some(auth_date) = e.get("authorized_date").filter(|date| truthy(date)) {
        result.insert("authorized_date".into(), date_time_string(auth_date)?);
    }
    if let Some(date) = e.get("date").filter(|date| truthy(date)) {
        result.insert("date".into(), date_time_string(date)?);
    }
    if let Some(existing) = find_stored_transaction(e, maps) {
        match existing.get("label") {
            Some(label) => result.insert("label".into(), label.clone()),
            None => result.shift_remove("label"),
        };
    }
    Ok(result)
}

/// A removed transaction's id: `e.transaction_id`.
fn removed_id(e: &Json) -> String {
    match e.get("transaction_id") {
        Some(Json::String(id)) => id.clone(),
        other => interpolate(other),
    }
}

/// Stores what `/transactions/sync` returned: the new and changed rows, the
/// removals, the pending→posted migrations, then the item's cursor.
async fn store_transactions(
    user: &MaskedUser,
    item_id: &str,
    fetched: PlaidTransactionsResponse,
    stored: &AccountTransactions,
) -> anyhow::Result<Counts> {
    let PlaidTransactionsResponse { items, added, removed, modified } = fetched;
    let lookup_maps = build_transaction_lookup_maps(&stored.transactions);

    let mut modeled = Vec::with_capacity(added.len() + modified.len());
    for e in added.iter().chain(modified.iter()) {
        modeled.push(modelize(e, &lookup_maps)?);
    }
    let removed_transaction_ids: Vec<String> = removed.iter().map(removed_id).collect();

    // Pending → posted transitions across both batches, to migrate the
    // `rejected_categories` rows and re-point the `split_transactions` rows
    // from the old pending id to the new posted id once the posted row is in.
    let pending_posted_transitions = detect_pending_posted_transitions(added.iter().chain(modified.iter()));

    let updated = get_date_string(JsDate::now());
    let partial_items: Vec<Obj> = items
        .iter()
        .map(|i| {
            let mut partial = Obj::new();
            partial.insert("item_id".into(), i.get("item_id").cloned().unwrap_or(Json::Null));
            if let Some(cursor) = i.get("cursor") {
                partial.insert("cursor".into(), cursor.clone());
            }
            partial.insert("updated".into(), json!(updated));
            partial
        })
        .collect();

    // Sequenced, not all at once: the re-point MUST run after the upsert (so
    // the posted row exists) and before the removal cascade
    // (`delete_transactions` soft-deletes splits by `transaction_id`, which
    // would tombstone the pending row's splits before they could ride
    // across). Once re-pointed, the cascade finds no live splits under the
    // pending id and the posted id is never among the removed, so the splits
    // survive.
    let stored_rows = async {
        // Never fails: a row that cannot be written is logged.
        upsert_transactions(user, &modeled, None).await;

        // Re-point live splits for each transition, all at once. A failure is
        // logged and does not interrupt counting: a failed re-point leaves the
        // splits under the pending id, where the cascade below tombstones
        // them, which is the old behaviour and not a worse one.
        let repoints = futures::future::join_all(
            pending_posted_transitions.iter().map(|t| repoint_split_transactions_on_pending_posted(user, &t.pending, &t.posted)),
        )
        .await;
        for (t, result) in pending_posted_transitions.iter().zip(repoints) {
            if let Err(error) = result {
                logger::warn(
                    "Failed to re-point split_transactions on pending→posted",
                    Some(&crate::ctx! { "pending": t.pending, "posted": t.posted }),
                    Some(&error),
                );
            }
        }

        let (deleted, split_deletes) = futures::join!(
            delete_transactions(user, &removed_transaction_ids, None),
            futures::future::join_all(removed_transaction_ids.iter().map(|tx_id| delete_split_transactions_by_transaction(user, tx_id, None))),
        );
        deleted?;
        for result in split_deletes {
            result?;
        }

        // Migrate the rejected_categories rows of each pending → posted pair,
        // after the upsert so the posted row exists. Each touches a distinct
        // pending id, so they run all at once; a failure is logged and does
        // not interrupt counting, and each is idempotent.
        let migrations = futures::future::join_all(
            pending_posted_transitions.iter().map(|t| migrate_rejected_categories_on_pending_posted(&t.pending, &t.posted)),
        )
        .await;
        for (t, result) in pending_posted_transitions.iter().zip(migrations) {
            if let Err(error) = result {
                logger::warn(
                    "Failed to migrate rejected_categories on pending→posted",
                    Some(&crate::ctx! { "pending": t.pending, "posted": t.posted }),
                    Some(&error),
                );
            }
        }

        // `upsert_items` reports a failed write per item and never fails itself.
        upsert_items(user, &partial_items, None).await;
        anyhow::Ok(())
    };

    if let Err(error) = stored_rows.await {
        logger::error("Error occurred during storing Plaid transactions data", Some(&crate::ctx! { "itemId": item_id }), Some(&error));
        return Err(error);
    }
    Ok(Counts { added: added.len() as i64, modified: modified.len() as i64, removed: removed.len() as i64 })
}

/// Stores what `/investments/transactions/get` returned: every row in the
/// window, the removal of recent stored rows Plaid no longer lists, then the
/// item's watermark.
async fn store_investment_transactions(
    user: &MaskedUser,
    item_id: &str,
    fetched: PlaidInvestmentTransactionsResponse,
    stored: &AccountTransactions,
) -> anyhow::Result<Counts> {
    let PlaidInvestmentTransactionsResponse { items, investment_transactions } = fetched;

    let mut filled_investments: Vec<Json> = Vec::with_capacity(investment_transactions.len());
    for e in &investment_transactions {
        let mut result = into_obj(e);
        result.insert("label".into(), json!({}));
        if let Some(date) = e.get("date").filter(|date| truthy(date)) {
            result.insert("date".into(), date_time_string(date)?);
        }
        filled_investments.push(Json::Object(result));
    }

    // The stored read includes deleted rows for the label carry-over of the
    // transactions branch; the removal check here must not see tombstones.
    let stored_investment_transactions: Vec<Json> =
        stored.investment_transactions.iter().filter(|e| !truthy_opt(e.get("is_deleted"))).cloned().collect();

    let removed = get_plaid_removed_investment_transactions(&filled_investments, &stored_investment_transactions);
    let removed_id_set: HashSet<&str> = removed.iter().map(String::as_str).collect();

    let mut counts = Counts::default();
    // A recent stored row that is still listed counts as modified, not added.
    for e in &stored_investment_transactions {
        if text_id(e, "source") == Some("manual") {
            continue;
        }
        if age_of(e) > TWO_WEEKS {
            continue;
        }
        if !text_id(e, "investment_transaction_id").is_some_and(|id| removed_id_set.contains(id)) {
            counts.modified += 1;
            counts.added -= 1;
        }
    }

    let partial_items: Vec<Obj> = items
        .iter()
        .map(|i| {
            let mut partial = Obj::new();
            partial.insert("item_id".into(), i.get("item_id").cloned().unwrap_or(Json::Null));
            if let Some(updated) = i.get("updated") {
                partial.insert("updated".into(), updated.clone());
            }
            partial
        })
        .collect();

    let filled: Vec<Obj> = filled_investments.iter().map(into_obj).collect();
    let stored_rows = async {
        let (_, deleted) =
            futures::join!(upsert_investment_transactions(user, &filled, None), delete_investment_transactions(user, &removed, None));
        deleted?;
        upsert_items(user, &partial_items, None).await;
        anyhow::Ok(())
    };
    if let Err(error) = stored_rows.await {
        logger::error(
            "Error occurred during storing Plaid investment transactions data",
            Some(&crate::ctx! { "itemId": item_id }),
            Some(&error),
        );
        return Err(error);
    }
    counts.added += filled_investments.len() as i64;
    counts.removed += removed.len() as i64;
    Ok(counts)
}

/// What an accounts sync stored: the item's accounts, and its investment
/// accounts when the holdings were fetched.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SyncAccountsResult {
    pub accounts: Vec<Obj>,
    pub investment_accounts: Option<Vec<Obj>>,
}

/// `DEFAULT_GRAPH_OPTIONS`.
fn default_graph_options() -> Json {
    json!({ "useSnapshots": true, "useHoldingSnapshots": true, "useTransactions": true })
}

/// `value ?? fallback` for a field of a stored row that may not exist.
fn stored_or(existing: Option<&Json>, key: &str, fallback: Json) -> Json {
    match existing.and_then(|existing| existing.get(key)) {
        Some(value) if !value.is_null() => value.clone(),
        _ => fallback,
    }
}

/// Fetches the item's accounts, and its holdings and securities when it has
/// the Investments product, and stores them with their snapshots. `None` when
/// there is no such Plaid item.
///
/// Both are fetched and stored at once, as in the TypeScript, with the
/// accounts request going to Plaid before the holdings request (`in_call_order`).
pub async fn sync_plaid_accounts(item_id: &str) -> anyhow::Result<Option<SyncAccountsResult>> {
    sync_plaid_accounts_of(item_id, get_user_item(item_id).await).await
}

/// [`sync_plaid_accounts`] of an item already read: `read` is what
/// [`get_user_item`] answered for `item_id`.
pub async fn sync_plaid_accounts_of(item_id: &str, read: anyhow::Result<Option<UserItem>>) -> anyhow::Result<Option<SyncAccountsResult>> {
    let Some(UserItem { user, item }) = read? else { return Ok(None) };
    if item.get("provider").and_then(Json::as_str) != Some(PLAID) {
        return Ok(None);
    }

    let stored_accounts = search_accounts_by_item_id(&user, item_id).await?;
    let account_ids: Vec<String> = stored_accounts.iter().filter_map(|e| text_id(e, "account_id").map(str::to_string)).collect();
    let stored_holdings: Vec<Obj> = search_holdings_by_account_id(&user, &account_ids).await?.iter().map(into_obj).collect();

    let stored_accounts_map: HashMap<&str, &Json> =
        stored_accounts.iter().filter_map(|e| text_id(e, "account_id").map(|id| (id, e))).collect();
    let institution_id = item.get("institution_id").filter(|id| truthy(id)).cloned().unwrap_or_else(|| json!("unknown"));
    let merge_with_existing = |a: &Json| -> Obj {
        let existing = text_id(a, "account_id").and_then(|id| stored_accounts_map.get(id)).copied();
        let mut merged = into_obj(a);
        merged.insert("institution_id".into(), institution_id.clone());
        merged.insert("item_id".into(), item.get("item_id").cloned().unwrap_or(Json::Null));
        merged.insert("hide".into(), stored_or(existing, "hide", json!(false)));
        merged.insert("custom_name".into(), stored_or(existing, "custom_name", json!("")));
        merged.insert("label".into(), stored_or(existing, "label", json!({ "budget_id": null })));
        merged.insert("graphOptions".into(), stored_or(existing, "graphOptions", default_graph_options()));
        merged
    };
    let stored_account_rows: Vec<Obj> = stored_accounts.iter().map(into_obj).collect();
    let items = [item.clone()];

    let sync_accounts = async {
        let stored = async {
            let accounts: Vec<Obj> = get_accounts(&user, &items).await?.accounts.iter().map(merge_with_existing).collect();
            report_account_id_churn(&accounts, &stored_accounts)?;
            upsert_accounts_with_snapshots(&user, &accounts, &stored_account_rows).await;
            anyhow::Ok(accounts)
        };
        match stored.await {
            Ok(accounts) => Ok(accounts),
            Err(error) => {
                logger::error("Sync accounts failed", Some(&crate::ctx! { "itemId": item_id }), Some(&error));
                Err(error)
            }
        }
    };

    // Reading the products of an item that has no list fails the sync, but
    // only once the accounts request is on its way, as in the TypeScript.
    let is_investment_available = has_product(&item, INVESTMENTS);
    let Ok(is_investment_available) = is_investment_available else {
        let _ = in_call_order(sync_accounts).await;
        return Err(is_investment_available.unwrap_err());
    };

    let sync_holdings = async {
        if !is_investment_available {
            return anyhow::Ok(None);
        }
        let stored = async {
            let PlaidHoldingsResponse { accounts, holdings, securities, .. } = get_holdings(&user, &items).await?;
            let accounts: Vec<Obj> = accounts.iter().map(merge_with_existing).collect();
            let holdings: Vec<Obj> = holdings.iter().map(into_obj).collect();
            let securities: Vec<Obj> = securities.iter().map(into_obj).collect();

            // Infer a USD cash holding for any investment account where Plaid
            // didn't surface cash as a holding. The inferred row is a real
            // holding snapshot, the same data path as Plaid-provided cash, so
            // the UI is identical whatever the source.
            let inferred_cash = infer_cash_holdings(&accounts, &holdings, &securities).await?;
            let mut all_holdings = holdings;
            all_holdings.extend(inferred_cash);

            upsert_accounts_with_snapshots(&user, &accounts, &stored_account_rows).await;
            // Securities first, so holdings never reference a securities row
            // not written yet within the same sync.
            upsert_securities_with_snapshots(&securities, PriceSnapshotDate::ClosePriceAsOf).await;
            upsert_and_delete_holdings_with_snapshots(&user, &all_holdings, &stored_holdings).await?;
            anyhow::Ok(accounts)
        };
        match stored.await {
            Ok(accounts) => Ok(Some(accounts)),
            Err(error) => {
                logger::error("Sync holdings failed", Some(&crate::ctx! { "itemId": item_id }), Some(&error));
                Err(error)
            }
        }
    };

    let (accounts, investment_accounts) = in_call_order(async { futures::join!(sync_accounts, sync_holdings) }).await;
    Ok(Some(SyncAccountsResult { accounts: accounts?, investment_accounts: investment_accounts? }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tx(overrides: Json) -> Json {
        let mut base = json!({
            "transaction_id": "tx-default",
            "account_id": "acc-1",
            "name": "Coffee",
            "amount": 5,
            "pending_transaction_id": null,
            "label": {},
        });
        for (key, value) in overrides.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    }

    fn account(overrides: Json) -> Obj {
        let mut base = json!({
            "account_id": "acc-new",
            "item_id": "item-1",
            "name": "Everyday Checking",
            "mask": "1234",
            "subtype": "checking",
        });
        for (key, value) in overrides.as_object().unwrap() {
            base[key] = value.clone();
        }
        into_obj(&base)
    }

    fn stored_account(overrides: Json) -> Json {
        Json::Object(account(overrides))
    }

    fn today() -> String {
        JsDate::now().to_iso_string().unwrap()[..10].to_string()
    }

    fn inv(overrides: Json) -> Json {
        let mut base = json!({ "investment_transaction_id": "inv-default", "account_id": "acc-1", "date": today() });
        for (key, value) in overrides.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    }

    fn churn(old: &str, new: &str, name: &str) -> AccountIdChurn {
        AccountIdChurn {
            item_id: Some(json!("item-1")),
            old_account_id: Some(json!(old)),
            new_account_id: Some(json!(new)),
            name: Some(json!(name)),
            mask: Some(json!("1234")),
            subtype: Some(json!("checking")),
        }
    }

    // buildTransactionLookupMaps

    #[test]
    fn indexes_by_transaction_id_and_by_pending_transaction_id_when_present() {
        let stored = [tx(json!({ "transaction_id": "tx-1", "pending_transaction_id": "ptx-1" })), tx(json!({ "transaction_id": "tx-2" }))];
        let maps = build_transaction_lookup_maps(&stored);
        assert_eq!(maps.by_transaction_id.get("tx-1"), Some(&&stored[0]));
        assert_eq!(maps.by_pending_id.get("ptx-1"), Some(&&stored[0]));
        assert_eq!(maps.by_transaction_id.len(), 2);
        // A null back-pointer is not indexed.
        assert_eq!(maps.by_pending_id.len(), 1);
    }

    // findStoredTransaction

    #[test]
    fn matches_by_the_same_transaction_id() {
        let stored = [tx(json!({ "transaction_id": "tx-1", "label": { "budget_id": "b-1" } }))];
        let maps = build_transaction_lookup_maps(&stored);
        let found = find_stored_transaction(&json!({ "transaction_id": "tx-1", "pending_transaction_id": null }), &maps);
        assert_eq!(found, Some(&stored[0]));
        assert_eq!(found.unwrap()["label"], json!({ "budget_id": "b-1" }));
    }

    #[test]
    fn matches_a_posted_row_to_the_stored_pending_row_it_names() {
        let stored = [tx(json!({ "transaction_id": "PENDING-1", "label": { "budget_id": "b-1" } }))];
        let maps = build_transaction_lookup_maps(&stored);
        let found = find_stored_transaction(&json!({ "transaction_id": "POSTED-1", "pending_transaction_id": "PENDING-1" }), &maps);
        assert_eq!(found.unwrap()["label"], json!({ "budget_id": "b-1" }));
    }

    #[test]
    fn matches_a_re_served_pending_id_to_the_stored_posted_row_pointing_at_it() {
        let stored = [tx(json!({ "transaction_id": "POSTED-1", "pending_transaction_id": "ptx-1" }))];
        let maps = build_transaction_lookup_maps(&stored);
        let found = find_stored_transaction(&json!({ "transaction_id": "ptx-1", "pending_transaction_id": null }), &maps);
        assert_eq!(found, Some(&stored[0]));
    }

    #[test]
    fn prefers_the_exact_id_over_the_pending_back_pointer() {
        let stored = [
            tx(json!({ "transaction_id": "tx-1", "label": { "budget_id": "b-exact" } })),
            tx(json!({ "transaction_id": "PENDING-1", "label": { "budget_id": "b-pending" } })),
        ];
        let maps = build_transaction_lookup_maps(&stored);
        let found = find_stored_transaction(&json!({ "transaction_id": "tx-1", "pending_transaction_id": "PENDING-1" }), &maps);
        assert_eq!(found.unwrap()["label"], json!({ "budget_id": "b-exact" }));
    }

    #[test]
    fn finds_nothing_without_an_id_match_even_for_the_same_name_and_amount() {
        let stored = [tx(json!({ "transaction_id": "tx-jan", "name": "NETFLIX", "amount": 14.99, "label": { "budget_id": "b-subs" } }))];
        let maps = build_transaction_lookup_maps(&stored);
        let incoming =
            json!({ "transaction_id": "tx-feb", "pending_transaction_id": null, "account_id": "acc-1", "name": "NETFLIX", "amount": 14.99 });
        assert_eq!(find_stored_transaction(&incoming, &maps), None);
        assert_eq!(find_stored_transaction(&json!({ "transaction_id": "tx-fresh", "pending_transaction_id": null }), &maps), None);
    }

    // detectPendingPostedTransitions

    #[test]
    fn a_posted_row_pointing_at_its_pending_row_is_a_transition() {
        let incoming = [tx(json!({ "transaction_id": "POSTED-1", "pending_transaction_id": "PENDING-1" }))];
        assert_eq!(
            detect_pending_posted_transitions(&incoming),
            vec![PendingPostedTransition { pending: "PENDING-1".into(), posted: "POSTED-1".into() }]
        );
    }

    #[test]
    fn no_back_pointer_or_one_pointing_at_itself_is_no_transition() {
        let incoming = [
            tx(json!({ "transaction_id": "tx-recurring-feb", "name": "NETFLIX", "amount": 14.99 })),
            tx(json!({ "transaction_id": "ptx-1", "pending_transaction_id": null })),
            tx(json!({ "transaction_id": "tx-A", "pending_transaction_id": "tx-A" })),
        ];
        assert_eq!(detect_pending_posted_transitions(&incoming), vec![]);
    }

    #[test]
    fn a_mixed_batch_yields_only_the_genuine_supersession() {
        let incoming = [
            tx(json!({ "transaction_id": "POSTED-1", "pending_transaction_id": "PENDING-1" })),
            tx(json!({ "transaction_id": "tx-recurring-feb", "name": "NETFLIX", "amount": 14.99 })),
            tx(json!({ "transaction_id": "tx-fresh" })),
        ];
        assert_eq!(
            detect_pending_posted_transitions(&incoming),
            vec![PendingPostedTransition { pending: "PENDING-1".into(), posted: "POSTED-1".into() }]
        );
    }

    // detectAccountIdChurn

    #[test]
    fn a_new_id_matching_name_case_insensitively_mask_and_subtype_on_the_same_item_is_churn() {
        let stored = [stored_account(json!({ "account_id": "acc-old" }))];
        let incoming = [account(json!({ "account_id": "acc-new", "name": "everyday checking" }))];
        assert_eq!(detect_account_id_churn(&incoming, &stored).unwrap(), vec![churn("acc-old", "acc-new", "everyday checking")]);
    }

    #[test]
    fn a_known_id_or_a_different_mask_subtype_name_or_item_is_no_churn() {
        let stored = [stored_account(json!({ "account_id": "acc-old" }))];
        for overrides in [
            json!({ "account_id": "acc-old" }),
            json!({ "mask": "5678" }),
            json!({ "subtype": "savings" }),
            json!({ "name": "Everyday Savings" }),
            json!({ "item_id": "item-2" }),
        ] {
            assert_eq!(detect_account_id_churn(&[account(overrides.clone())], &stored).unwrap(), vec![], "{overrides}");
        }
    }

    #[test]
    fn a_batch_yields_only_the_genuine_churn_pair() {
        let stored = [stored_account(json!({ "account_id": "acc-old" }))];
        let incoming = [
            account(json!({ "account_id": "acc-new", "name": "everyday checking" })),
            account(json!({ "account_id": "acc-brand-new", "name": "Travel Rewards", "mask": "9999" })),
            account(json!({ "account_id": "acc-old" })),
        ];
        assert_eq!(detect_account_id_churn(&incoming, &stored).unwrap(), vec![churn("acc-old", "acc-new", "everyday checking")]);
    }

    #[test]
    fn the_live_successor_is_preferred_over_an_archived_predecessor() {
        let stored = [
            stored_account(json!({ "account_id": "acc-archived", "archived": true })),
            stored_account(json!({ "account_id": "acc-live", "archived": false })),
        ];
        assert_eq!(
            detect_account_id_churn(&[account(json!({ "account_id": "acc-new" }))], &stored).unwrap(),
            vec![churn("acc-live", "acc-new", "Everyday Checking")]
        );
    }

    #[test]
    fn every_tied_sibling_is_reported_when_all_matches_are_archived() {
        let stored = [
            stored_account(json!({ "account_id": "acc-old-1", "archived": true })),
            stored_account(json!({ "account_id": "acc-old-2", "archived": true })),
        ];
        assert_eq!(
            detect_account_id_churn(&[account(json!({ "account_id": "acc-new" }))], &stored).unwrap(),
            vec![churn("acc-old-1", "acc-new", "Everyday Checking"), churn("acc-old-2", "acc-new", "Everyday Checking")]
        );
    }

    #[test]
    fn a_stored_sibling_without_a_name_fails_as_javascript_does() {
        let stored = [stored_account(json!({ "account_id": "acc-old", "name": null }))];
        let error = detect_account_id_churn(&[account(json!({}))], &stored).unwrap_err();
        assert_eq!(error.to_string(), "null is not an object (evaluating 's.name.toLowerCase')");
    }

    // getPlaidRemovedInvestmentTransactions

    #[test]
    fn recent_stored_rows_no_longer_listed_are_removed() {
        let incoming = [inv(json!({ "investment_transaction_id": "inv-1" }))];
        let stored = [inv(json!({ "investment_transaction_id": "inv-1" })), inv(json!({ "investment_transaction_id": "inv-2" }))];
        assert_eq!(get_plaid_removed_investment_transactions(&incoming, &stored), vec!["inv-2".to_string()]);
        assert_eq!(get_plaid_removed_investment_transactions(&incoming, &stored[..1]), Vec::<String>::new());
        assert_eq!(get_plaid_removed_investment_transactions(&incoming, &[]), Vec::<String>::new());
        assert_eq!(get_plaid_removed_investment_transactions(&[], &stored), vec!["inv-1".to_string(), "inv-2".to_string()]);
    }

    #[test]
    fn manual_rows_and_rows_older_than_two_weeks_are_never_removed() {
        let old = JsDate::from_ms(JsDate::now_ms() - 15.0 * 24.0 * 60.0 * 60.0 * 1000.0).to_iso_string().unwrap()[..10].to_string();
        let stored = [
            inv(json!({ "investment_transaction_id": "manual-1", "source": "manual" })),
            inv(json!({ "investment_transaction_id": "inv-old", "date": old })),
        ];
        assert_eq!(get_plaid_removed_investment_transactions(&[], &stored), Vec::<String>::new());
    }

    // The products an item syncs.

    #[test]
    fn an_item_without_a_product_list_fails_as_javascript_does() {
        assert!(has_product(&json!({ "available_products": ["transactions"] }), TRANSACTIONS).unwrap());
        assert!(!has_product(&json!({ "available_products": ["transactions"] }), INVESTMENTS).unwrap());
        assert_eq!(
            has_product(&json!({ "available_products": null }), TRANSACTIONS).unwrap_err().to_string(),
            "null is not an object (evaluating 'item.available_products.includes')"
        );
    }

    #[test]
    fn modelize_writes_date_times_and_carries_the_stored_label() {
        let stored = [tx(json!({ "transaction_id": "P-1", "label": { "memo": "mine" } }))];
        let maps = build_transaction_lookup_maps(&stored);
        let incoming = json!({ "transaction_id": "POST-1", "pending_transaction_id": "P-1", "date": "2026-03-02", "authorized_date": null });
        let modeled = modelize(&incoming, &maps).unwrap();
        assert_eq!(
            Json::Object(modeled),
            json!({ "transaction_id": "POST-1", "pending_transaction_id": "P-1", "date": "2026-03-02T00:00:00", "authorized_date": null, "label": { "memo": "mine" } })
        );
        let fresh = modelize(&json!({ "transaction_id": "NEW", "authorized_date": "2026-03-01T10:00:00" }), &maps).unwrap();
        assert_eq!(Json::Object(fresh), json!({ "transaction_id": "NEW", "authorized_date": "2026-03-01T10:00:00", "label": {} }));
    }

    #[test]
    fn the_comparison_window_starts_a_month_before_the_last_sync_or_two_years_back() {
        let start = transactions_start_date(&json!({ "updated": "2026-03-15T12:00:00.000Z" }));
        assert_eq!(start.get_time(), JsDate::parse("2026-03-15T12:00:00.000Z").set_month(1).get_time());
        let now = JsDate::now();
        let never = transactions_start_date(&json!({}));
        assert_eq!(never.get_full_year(), now.get_full_year() - 2);
    }
}
