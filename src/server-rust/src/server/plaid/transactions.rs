//! Transactions and investment transactions of Plaid items:
//! `src/server/lib/plaid/transactions.ts`.

use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use serde_json::json;

use super::accounts::{extend_flat, has_investments, item_with_error, member, status_reason_of, INVESTMENTS};
use super::util::{error_code_of, get_client, is_ignorable_error_code, is_item_error, logged_value, plaid_error_of, PlaidClient};
use crate::common::date::{get_date_string, local_date};
use crate::js::{to_number, truthy, Json, JsDate, Obj};
use crate::server::logger;
use crate::server::postgres::models::MaskedUser;
use crate::server::postgres::repositories::items::{update_item_status, upsert_items};

/// What `get_transactions` gathers: each item with its cursor advanced as far
/// as its pages went (carrying `plaidError` when a page failed), and every
/// page's changes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlaidTransactionsResponse {
    pub items: Vec<Json>,
    pub added: Vec<Json>,
    pub removed: Vec<Json>,
    pub modified: Vec<Json>,
}

/// What `get_investment_transactions` gathers.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlaidInvestmentTransactionsResponse {
    pub items: Vec<Json>,
    pub investment_transactions: Vec<Json>,
}

/// The item writes a sync makes when Plaid reports a problem with an item.
/// Both run in the background; a failure is logged.
pub trait ItemWrites: Send + Sync {
    /// `upsertItems(user, items)`.
    fn upsert_items(&self, user: MaskedUser, items: Vec<Obj>) -> BoxFuture<'static, anyhow::Result<()>>;
    /// `updateItemStatus(user, item_id, status, status_reason)`.
    fn update_item_status(
        &self,
        user: MaskedUser,
        item_id: String,
        status: &'static str,
        status_reason: Option<String>,
    ) -> BoxFuture<'static, anyhow::Result<()>>;
}

/// The writes through the items repository.
pub struct RepositoryItemWrites;

impl ItemWrites for RepositoryItemWrites {
    fn upsert_items(&self, user: MaskedUser, items: Vec<Obj>) -> BoxFuture<'static, anyhow::Result<()>> {
        Box::pin(async move {
            // Reports a failed write per item and never fails itself.
            upsert_items(&user, &items, None).await;
            Ok(())
        })
    }

    fn update_item_status(
        &self,
        user: MaskedUser,
        item_id: String,
        status: &'static str,
        status_reason: Option<String>,
    ) -> BoxFuture<'static, anyhow::Result<()>> {
        Box::pin(async move {
            update_item_status(&user, &item_id, status, status_reason.as_deref()).await?;
            Ok(())
        })
    }
}

/// Marks the item `bad` in the background with the error's code as the reason.
fn mark_item_bad(writes: &Arc<dyn ItemWrites>, user: &MaskedUser, item_id: &Json, plaid_error: &Json) {
    let item_id_text = item_id.as_str().unwrap_or_default().to_string();
    let reason = status_reason_of(plaid_error.get("error_code"));
    let write = writes.update_item_status(user.clone(), item_id_text, "bad", reason);
    let item_id = item_id.clone();
    tokio::spawn(async move {
        if let Err(error) = write.await {
            logger::error("Failed to update item status to BAD", Some(&crate::ctx! { "itemId": item_id }), Some(&error));
        }
    });
}

/// The item with Investments removed from its products, written in the background.
fn drop_investments(writes: &Arc<dyn ItemWrites>, user: &MaskedUser, item: &Obj, item_id: &Json) {
    let updated_products: Vec<Json> = match item.get("available_products") {
        Some(Json::Array(products)) => products.iter().filter(|product| product.as_str() != Some(INVESTMENTS)).cloned().collect(),
        _ => Vec::new(),
    };
    let mut updated = item.clone();
    updated.insert("available_products".into(), Json::Array(updated_products));
    let write = writes.upsert_items(user.clone(), vec![updated]);
    let item_id = item_id.clone();
    tokio::spawn(async move {
        if let Err(error) = write.await {
            logger::error("Failed to update available_products for item", Some(&crate::ctx! { "itemId": item_id }), Some(&error));
        }
    });
}

/// Pages through `/transactions/sync` for each item from its cursor, all items
/// at once. A failed page ends that item's sync where it was, carrying the
/// error (`plaidError`); an item error marks the item `bad`.
pub async fn get_transactions(user: &MaskedUser, items: &[Json]) -> anyhow::Result<PlaidTransactionsResponse> {
    let client = get_client(Some(user))?;
    let writes: Arc<dyn ItemWrites> = Arc::new(RepositoryItemWrites);

    // Pushed as each item's sync settles, as the TypeScript's jobs push.
    let data = Mutex::new(PlaidTransactionsResponse::default());

    let fetch_jobs = items.iter().map(|original| {
        let (client, data, writes) = (&client, &data, &writes);
        async move {
            let mut item = original.as_object().cloned().unwrap_or_default();
            let mut this_item_added = Vec::new();
            let mut this_item_removed = Vec::new();
            let mut this_item_modified = Vec::new();
            let mut has_more = true;
            let mut plaid_error: Option<Json> = None;

            while has_more {
                let item_id = item.get("item_id").cloned().unwrap_or(Json::Null);
                // `{ access_token, cursor }`: what is undefined is left out.
                let mut request = Obj::new();
                for key in ["access_token", "cursor"] {
                    if let Some(value) = item.get(key) {
                        request.insert(key.into(), value.clone());
                    }
                }

                let page = async {
                    let response = client.call("/transactions/sync", &Json::Object(request)).await?;
                    member(&response, "added")?;
                    anyhow::Ok(response)
                };
                match page.await {
                    Ok(response) => {
                        extend_flat(&mut this_item_added, response.get("added"));
                        extend_flat(&mut this_item_removed, response.get("removed"));
                        extend_flat(&mut this_item_modified, response.get("modified"));
                        has_more = response.get("has_more").is_some_and(truthy);
                        match response.get("next_cursor") {
                            Some(next_cursor) => item.insert("cursor".into(), next_cursor.clone()),
                            None => item.shift_remove("cursor"),
                        };
                    }
                    Err(error) => {
                        plaid_error = plaid_error_of(&error).cloned();
                        if error_code_of(plaid_error.as_ref()) == Some("ITEM_LOGIN_REQUIRED") {
                            logger::warn(
                                "Failed to get transactions data: ITEM_LOGIN_REQUIRED",
                                Some(&crate::ctx! { "itemId": item_id }),
                                None,
                            );
                        } else {
                            let logged = match plaid_error.as_ref().filter(|data| truthy(data)) {
                                Some(data) => logged_value(data),
                                None => error,
                            };
                            logger::error("Failed to get transactions data", Some(&crate::ctx! { "itemId": item_id }), Some(&logged));
                        }
                        if let Some(plaid_error) = plaid_error.as_ref().filter(|data| is_item_error(Some(data))) {
                            mark_item_bad(writes, user, &item_id, plaid_error);
                        }
                        has_more = false;
                    }
                }
            }

            let item = Json::Object(item);
            let mut data = data.lock().unwrap();
            match plaid_error.as_ref().filter(|data| truthy(data)) {
                Some(plaid_error) => data.items.push(item_with_error(&item, Some(plaid_error))),
                None => data.items.push(item),
            }
            data.added.extend(this_item_added);
            data.removed.extend(this_item_removed);
            data.modified.extend(this_item_modified);
        }
    });
    futures::future::join_all(fetch_jobs).await;

    Ok(data.into_inner().unwrap())
}

/// The client and the item writes `get_investment_transactions_with` uses:
/// the TypeScript's `deps` seam.
pub struct InvestmentTransactionDeps {
    pub client: PlaidClient,
    pub item_writes: Arc<dyn ItemWrites>,
}

/// The first day of the window to fetch: two weeks before the item last
/// synced, or two years back for an item that never did.
fn start_date_of(updated: Option<&Json>, now: JsDate) -> String {
    match updated.filter(|updated| truthy(updated)) {
        Some(updated) => {
            let updated_date = match updated {
                Json::String(text) => local_date(text),
                other => JsDate::from_json(other),
            };
            let date = updated_date.get_date();
            get_date_string(updated_date.set_date(date - 14))
        }
        None => {
            let this_year = now.get_full_year();
            get_date_string(JsDate::now().set_full_year(this_year - 2))
        }
    }
}

/// `offset < total` as JavaScript compares a number with whatever Plaid sent.
fn below(offset: f64, total: &Json) -> bool {
    let total = match total {
        Json::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Json::String(text) => to_number(text),
        Json::Bool(b) => f64::from(u8::from(*b)),
        Json::Null => 0.0,
        _ => f64::NAN,
    };
    offset < total
}

/// Pages through `/investments/transactions/get` for each item with the
/// Investments product, all items at once.
pub async fn get_investment_transactions(user: &MaskedUser, items: &[Json]) -> anyhow::Result<PlaidInvestmentTransactionsResponse> {
    let deps = InvestmentTransactionDeps { client: get_client(Some(user))?, item_writes: Arc::new(RepositoryItemWrites) };
    get_investment_transactions_with(user, items, &deps).await
}

/// [`get_investment_transactions`] with its client and item writes given.
///
/// The watermark (`updated`) advances only when every page succeeded: this
/// path is offset-based, so a skipped offset is never revisited, unlike the
/// cursor-based cash path, where the cursor itself is the resume point. A
/// failed page still pushes the item (carrying `plaidError` when the failure
/// had a Plaid payload, plain when it did not), so the item is never silently
/// dropped from the result; it is pushed exactly once per sync. An item Plaid
/// says does not support investment transactions loses the product, and is
/// left out when that was its first page.
pub async fn get_investment_transactions_with(
    user: &MaskedUser,
    items: &[Json],
    deps: &InvestmentTransactionDeps,
) -> anyhow::Result<PlaidInvestmentTransactionsResponse> {
    let data = Mutex::new(PlaidInvestmentTransactionsResponse::default());
    let all_investment_transactions: Mutex<Vec<Json>> = Mutex::new(Vec::new());

    let fetch_jobs = items.iter().map(|original| {
        let (data, all_investment_transactions) = (&data, &all_investment_transactions);
        async move {
            // A copy: the watermark write below must not change the caller's item.
            let mut item = original.as_object().cloned().unwrap_or_default();
            let item_id = item.get("item_id").cloned().unwrap_or(Json::Null);
            if !has_investments(original)? {
                return anyhow::Ok(());
            }

            let now = JsDate::now();
            let start_date = start_date_of(item.get("updated"), now);
            let end_date = get_date_string(now);
            let count = 100.0;
            let mut offset = 0.0;

            // `None` is `undefined`: no page has answered yet.
            let mut total: Option<Json> = None;
            let mut plaid_error: Option<Json> = None;
            let mut succeeded = false;
            // A non-ignorable page failure. The watermark gate reads this flag,
            // not whether there is a `plaid_error`: a failure with no Plaid
            // payload (a transport error) leaves that unset.
            let mut failed = false;

            while total.as_ref().is_none_or(|total| below(offset, total)) {
                if total.is_none() {
                    total = Some(json!(0));
                }

                let mut request = Obj::new();
                if let Some(access_token) = item.get("access_token") {
                    request.insert("access_token".into(), access_token.clone());
                }
                request.insert("start_date".into(), json!(start_date));
                request.insert("end_date".into(), json!(end_date));
                request.insert("options".into(), json!({ "count": crate::js::num(count), "offset": crate::js::num(offset) }));

                let page = async {
                    let response = deps.client.call("/investments/transactions/get", &Json::Object(request)).await?;
                    let investment_transactions = member(&response, "investment_transactions")?.cloned();
                    anyhow::Ok((investment_transactions, response.get("total_investment_transactions").cloned()))
                };
                match page.await {
                    Ok((investment_transactions, page_total)) => {
                        total = page_total;
                        extend_flat(&mut all_investment_transactions.lock().unwrap(), investment_transactions.as_ref());
                        succeeded = true;
                    }
                    Err(error) => {
                        let error_data = plaid_error_of(&error).cloned();
                        let error_code = error_data.as_ref().and_then(|data| data.get("error_code")).cloned();
                        let code_text = error_code.as_ref().and_then(Json::as_str);
                        if code_text == Some("PRODUCTS_NOT_SUPPORTED") {
                            logger::info(
                                "Investment transactions not supported for item, removing Investments from available_products",
                                Some(&crate::ctx! { "itemId": item_id }),
                            );
                            drop_investments(&deps.item_writes, user, &item, &item_id);
                            // On the first page nothing was ever pushed, so the item
                            // is left out. After a successful page it is pushed once
                            // below, without advancing the watermark.
                            if !succeeded {
                                return anyhow::Ok(());
                            }
                            failed = true;
                            break;
                        } else if !error_code.as_ref().is_some_and(truthy) || !code_text.is_some_and(is_ignorable_error_code) {
                            let logged = match error_data.as_ref().filter(|data| truthy(data)) {
                                Some(data) => logged_value(data),
                                None => error,
                            };
                            logger::error(
                                "Failed to get investment transaction data",
                                Some(&crate::ctx! { "itemId": item_id }),
                                Some(&logged),
                            );
                            failed = true;
                            if !plaid_error.as_ref().is_some_and(truthy) {
                                plaid_error = error_data.clone();
                            }
                            if let Some(error_data) = error_data.as_ref().filter(|data| is_item_error(Some(data))) {
                                mark_item_bad(&deps.item_writes, user, &item_id, error_data);
                            }
                            break;
                        }
                    }
                }

                offset += count;
            }

            if succeeded && !failed {
                item.insert("updated".into(), json!(end_date));
            }
            let item = Json::Object(item);
            let mut data = data.lock().unwrap();
            match plaid_error.as_ref().filter(|data| truthy(data)) {
                Some(plaid_error) => data.items.push(item_with_error(&item, Some(plaid_error))),
                None if failed || succeeded => data.items.push(item),
                None => {}
            }
            anyhow::Ok(())
        }
    });
    for result in futures::future::join_all(fetch_jobs).await {
        result?;
    }

    let mut data = data.into_inner().unwrap();
    data.investment_transactions = all_investment_transactions.into_inner().unwrap();
    Ok(data)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::server::plaid::util::PlaidError;

    // `transactions.test.ts`, "getInvestmentTransactions".

    #[derive(Default)]
    struct FakeWrites {
        upserts: AtomicUsize,
        status_updates: AtomicUsize,
    }

    impl ItemWrites for FakeWrites {
        fn upsert_items(&self, _: MaskedUser, _: Vec<Obj>) -> BoxFuture<'static, anyhow::Result<()>> {
            self.upserts.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
        fn update_item_status(&self, _: MaskedUser, _: String, _: &'static str, _: Option<String>) -> BoxFuture<'static, anyhow::Result<()>> {
            self.status_updates.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
    }

    fn user() -> MaskedUser {
        MaskedUser { user_id: "u".to_string(), username: "u".to_string() }
    }

    fn item() -> Json {
        json!({ "item_id": "item-1", "access_token": "test-access-token", "updated": "2020-01-01", "available_products": ["investments"] })
    }

    fn ok_response(offset: u64, count: u64, total: u64) -> Result<Json, PlaidError> {
        let page: Vec<Json> = (0..count).map(|i| json!({ "investment_transaction_id": format!("inv-{}", offset + i) })).collect();
        Ok(json!({ "investment_transactions": page, "total_investment_transactions": total }))
    }

    fn plaid_failure(code: &str) -> PlaidError {
        PlaidError::from_response(400, json!({ "error_code": code, "error_type": "API_ERROR" }))
    }

    fn offset_of(body: &Json) -> u64 {
        body["options"]["offset"].as_u64().unwrap()
    }

    fn deps(answer: impl Fn(u64) -> Result<Json, PlaidError> + Send + Sync + 'static) -> (InvestmentTransactionDeps, Arc<FakeWrites>) {
        let client = PlaidClient::answering(move |_, body| answer(offset_of(body)));
        let writes = Arc::new(FakeWrites::default());
        (InvestmentTransactionDeps { client, item_writes: writes.clone() }, writes)
    }

    fn paged(total: u64) -> impl Fn(u64) -> Result<Json, PlaidError> {
        move |offset| ok_response(offset, 100.min(total - offset), total)
    }

    #[tokio::test]
    async fn pushes_the_item_exactly_once_and_advances_the_watermark_on_a_clean_multi_page_run() {
        let (deps, _) = deps(paged(250));
        let item = item();
        let data = get_investment_transactions_with(&user(), std::slice::from_ref(&item), &deps).await.unwrap();
        assert_eq!(data.items.len(), 1);
        assert_eq!(data.investment_transactions.len(), 250);
        assert_eq!(data.items[0]["updated"], json!(get_date_string(JsDate::now())));
        // The caller's object is not changed.
        assert_eq!(item["updated"], json!("2020-01-01"));
    }

    #[tokio::test]
    async fn does_not_advance_the_watermark_when_a_mid_pagination_page_fails() {
        let page = paged(250);
        let (deps, _) = deps(move |offset| if offset == 100 { Err(plaid_failure("INTERNAL_SERVER_ERROR")) } else { page(offset) });
        let data = get_investment_transactions_with(&user(), &[item()], &deps).await.unwrap();
        assert_eq!(data.items.len(), 1);
        assert_eq!(data.items[0]["plaidError"]["error_code"], json!("INTERNAL_SERVER_ERROR"));
        assert_eq!(data.items[0]["updated"], json!("2020-01-01"));
        assert_eq!(data.investment_transactions.len(), 100);
    }

    #[tokio::test]
    async fn does_not_advance_the_watermark_when_a_page_fails_without_a_plaid_response_payload() {
        let page = paged(250);
        let (deps, _) = deps(move |offset| if offset == 100 { Err(PlaidError::transport("socket hangup")) } else { page(offset) });
        let data = get_investment_transactions_with(&user(), &[item()], &deps).await.unwrap();
        assert_eq!(data.items.len(), 1);
        assert!(data.items[0].get("plaidError").is_none());
        assert_eq!(data.items[0]["updated"], json!("2020-01-01"));
        assert_eq!(data.investment_transactions.len(), 100);
    }

    #[tokio::test]
    async fn pushes_the_item_without_a_plaid_error_when_the_first_page_fails_without_a_payload() {
        let (deps, _) = deps(|_| Err(PlaidError::transport("socket hangup")));
        let data = get_investment_transactions_with(&user(), &[item()], &deps).await.unwrap();
        assert_eq!(data.items.len(), 1);
        assert!(data.items[0].get("plaidError").is_none());
        assert_eq!(data.items[0]["updated"], json!("2020-01-01"));
        assert!(data.investment_transactions.is_empty());
    }

    #[tokio::test]
    async fn pushes_the_item_without_advancing_the_watermark_when_products_not_supported_follows_a_page() {
        let (deps, writes) =
            deps(|offset| if offset == 100 { Err(plaid_failure("PRODUCTS_NOT_SUPPORTED")) } else { ok_response(offset, 100, 250) });
        let data = get_investment_transactions_with(&user(), &[item()], &deps).await.unwrap();
        assert_eq!(data.items.len(), 1);
        assert_eq!(data.items[0]["updated"], json!("2020-01-01"));
        assert_eq!(data.investment_transactions.len(), 100);
        assert_eq!(writes.upserts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn pushes_nothing_and_leaves_the_watermark_alone_on_products_not_supported() {
        let (deps, writes) = deps(|_| Err(plaid_failure("PRODUCTS_NOT_SUPPORTED")));
        let data = get_investment_transactions_with(&user(), &[item()], &deps).await.unwrap();
        assert!(data.items.is_empty());
        assert_eq!(writes.upserts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn pushes_nothing_on_ignorable_errors() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let (deps, writes) = deps(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            Err(plaid_failure("NO_INVESTMENT_ACCOUNTS"))
        });
        let data = get_investment_transactions_with(&user(), &[item()], &deps).await.unwrap();
        assert!(data.items.is_empty());
        assert!(calls.load(Ordering::SeqCst) > 0);
        assert_eq!(writes.status_updates.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn an_item_error_marks_the_item_bad() {
        let (deps, writes) = deps(|_| Err(PlaidError::from_response(400, json!({ "error_code": "ITEM_LOGIN_REQUIRED", "error_type": "ITEM_ERROR" }))));
        let data = get_investment_transactions_with(&user(), &[item()], &deps).await.unwrap();
        assert_eq!(data.items.len(), 1);
        tokio::task::yield_now().await;
        assert_eq!(writes.status_updates.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn an_item_without_investments_is_skipped() {
        let (deps, _) = deps(paged(1));
        let item = json!({ "item_id": "i", "available_products": ["transactions"] });
        let data = get_investment_transactions_with(&user(), &[item], &deps).await.unwrap();
        assert!(data.items.is_empty());
    }

    #[test]
    fn the_window_starts_two_weeks_before_the_last_sync_or_two_years_back() {
        let now = JsDate::now();
        assert_eq!(start_date_of(Some(&json!("2020-01-20")), now), "2020-01-06");
        assert_eq!(start_date_of(Some(&json!("2020-01-01")), now), "2019-12-18");
        let two_years_back = get_date_string(JsDate::now().set_full_year(now.get_full_year() - 2));
        assert_eq!(start_date_of(None, now), two_years_back);
        assert_eq!(start_date_of(Some(&json!("")), now), two_years_back);
    }
}
