//! The hourly background sync: `src/server/lib/compute-tools/schedule.ts`.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior};

use crate::js::Json;
use crate::server::alarm::send_alarm;
use crate::server::logger;
use crate::server::plaid::is_plaid_configured;
use crate::server::postgres::repositories::items::{get_all_items, update_item_sync_status, SyncResult};

use super::auto_suggest::run_auto_suggestions;
use super::detect_recurrings::run_recurring_detection;
use super::detect_transfers::run_transfer_detection;
use super::refresh_cpi_snapshots::refresh_cpi_snapshots;
use super::refresh_security_snapshots::refresh_active_security_snapshots;
use super::sync_plaid::{sync_plaid_accounts, sync_plaid_transactions, SyncAccountsResult, SyncTransactionsResult};
use super::sync_simple_fin::{sync_simple_fin_data, SyncSimpleFinResult};

/// How often the sync runs after the run at start-up.
const SYNC_INTERVAL: Duration = Duration::from_secs(60 * 60);

static IS_SYNCING: AtomicBool = AtomicBool::new(false);
static SYNC_TIMER: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);

/// What the sync of the items works with: the repositories, the provider
/// syncs and the alarm, or a test's stand-ins for them.
#[async_trait]
trait ItemSyncDeps: Send + Sync {
    fn is_plaid_configured(&self) -> bool;
    async fn get_all_items(&self) -> anyhow::Result<Vec<Json>>;
    async fn sync_plaid_accounts(&self, item_id: &str) -> anyhow::Result<Option<SyncAccountsResult>>;
    async fn sync_plaid_transactions(&self, item_id: &str) -> anyhow::Result<Option<SyncTransactionsResult>>;
    async fn sync_simple_fin_data(&self, item_id: &str) -> anyhow::Result<Option<SyncSimpleFinResult>>;
    async fn update_item_sync_status(&self, item_id: &str, result: &SyncResult) -> anyhow::Result<bool>;
    /// Sends the alarm in the background.
    fn send_alarm(&self, title: &'static str, detail: String);
}

/// The real repositories, syncs and alarm.
struct Providers;

#[async_trait]
impl ItemSyncDeps for Providers {
    fn is_plaid_configured(&self) -> bool {
        is_plaid_configured()
    }
    async fn get_all_items(&self) -> anyhow::Result<Vec<Json>> {
        get_all_items().await
    }
    async fn sync_plaid_accounts(&self, item_id: &str) -> anyhow::Result<Option<SyncAccountsResult>> {
        sync_plaid_accounts(item_id).await
    }
    async fn sync_plaid_transactions(&self, item_id: &str) -> anyhow::Result<Option<SyncTransactionsResult>> {
        sync_plaid_transactions(item_id).await
    }
    async fn sync_simple_fin_data(&self, item_id: &str) -> anyhow::Result<Option<SyncSimpleFinResult>> {
        sync_simple_fin_data(item_id).await
    }
    async fn update_item_sync_status(&self, item_id: &str, result: &SyncResult) -> anyhow::Result<bool> {
        update_item_sync_status(item_id, result).await
    }
    fn send_alarm(&self, title: &'static str, detail: String) {
        tokio::spawn(async move { send_alarm(title, &detail, None, false).await });
    }
}

/// `{ success: !syncError, error: syncError }`: an error with an empty message
/// counts as none, as an empty string is falsy.
fn sync_result(sync_error: &Option<String>) -> SyncResult {
    SyncResult { success: !sync_error.as_deref().is_some_and(|error| !error.is_empty()), error: sync_error.clone() }
}

/// Logs and alarms a failed step of an item's sync; answers the message the
/// item's sync status records.
fn report_failure(deps: &dyn ItemSyncDeps, item_id: &str, log: &str, alarm: &'static str, error: &anyhow::Error) -> String {
    logger::error(log, Some(&crate::ctx! { "itemId": item_id }), Some(error));
    let message = error.to_string();
    deps.send_alarm(alarm, format!("**Item:** {item_id}\n**Error:** {message}"));
    message
}

/// Syncs every connected item with its provider. A failure of one item is
/// logged, alarmed and recorded on the item; the rest still run.
async fn sync_items() -> anyhow::Result<()> {
    sync_items_with(&Providers).await
}

async fn sync_items_with(deps: &dyn ItemSyncDeps) -> anyhow::Result<()> {
    let items = deps.get_all_items().await?;
    if !deps.is_plaid_configured() {
        logger::info("Plaid is not configured — skipping Plaid sync for all items", None);
    }
    for item in &items {
        let item_id = item.get("item_id").and_then(Json::as_str).unwrap_or_default();
        match item.get("provider").and_then(Json::as_str) {
            Some("plaid") => {
                if !deps.is_plaid_configured() {
                    continue;
                }
                let mut accounts_count = 0;
                let mut transactions_count = 0;
                let mut sync_error: Option<String> = None;

                match deps.sync_plaid_accounts(item_id).await {
                    Ok(Some(result)) => {
                        accounts_count += result.accounts.len() + result.investment_accounts.as_ref().map_or(0, Vec::len);
                    }
                    other => {
                        let error = other.err().unwrap_or_else(|| anyhow::anyhow!("Error occured during syncAllPlaidAccounts"));
                        let message = report_failure(
                            deps,
                            item_id,
                            "Sync Plaid accounts failed",
                            "Scheduled Sync Error: Plaid accounts failed",
                            &error,
                        );
                        sync_error = Some(message);
                    }
                }

                if !sync_error.as_deref().is_some_and(|error| !error.is_empty()) {
                    match deps.sync_plaid_transactions(item_id).await {
                        Ok(Some(result)) => transactions_count += result.added + result.modified + result.removed,
                        other => {
                            let error =
                                other.err().unwrap_or_else(|| anyhow::anyhow!("Error occured during syncAllPlaidTransactions"));
                            let message = report_failure(
                                deps,
                                item_id,
                                "Sync Plaid transactions failed",
                                "Scheduled Sync Error: Plaid transactions failed",
                                &error,
                            );
                            sync_error = Some(message);
                        }
                    }
                }

                deps.update_item_sync_status(item_id, &sync_result(&sync_error)).await?;

                let mut context = crate::ctx! {
                    "itemId": item_id,
                    "accountsUpdated": accounts_count,
                    "transactionsUpdated": transactions_count,
                };
                if let Some(sync_error) = &sync_error {
                    context.insert("syncError".into(), Json::String(sync_error.clone()));
                }
                logger::info("Synced Plaid item", Some(&context));
            }
            Some("simple_fin") => {
                let mut sync_error: Option<String> = None;

                match deps.sync_simple_fin_data(item_id).await {
                    Ok(Some(result)) => {
                        let transactions_count = result.transactions.len() + result.investment_transactions.len();
                        logger::info(
                            "Synced SimpleFin item",
                            Some(&crate::ctx! {
                                "itemId": item_id,
                                "accountsUpdated": result.accounts.len(),
                                "transactionsUpdated": transactions_count,
                            }),
                        );
                    }
                    other => {
                        let error = other.err().unwrap_or_else(|| anyhow::anyhow!("Error occured during syncAllSimpleFinData"));
                        let message = report_failure(
                            deps,
                            item_id,
                            "Sync SimpleFin data failed",
                            "Scheduled Sync Error: SimpleFin data failed",
                            &error,
                        );
                        sync_error = Some(message);
                    }
                }

                deps.update_item_sync_status(item_id, &sync_result(&sync_error)).await?;
            }
            _ => {}
        }
    }
    Ok(())
}

async fn run_jobs() -> anyhow::Result<()> {
    sync_items().await?;
    if let Err(error) = run_auto_suggestions().await {
        logger::error("Auto-suggestion job failed", None, Some(&error));
    }
    if let Err(error) = run_transfer_detection().await {
        logger::error("Transfer-detection job failed", None, Some(&error));
    }
    if let Err(error) = run_recurring_detection().await {
        logger::error("Recurring-detection job failed", None, Some(&error));
    }
    match refresh_active_security_snapshots().await {
        Ok(counts) => logger::info("Refreshed active security snapshots", Some(&counts)),
        Err(error) => logger::error("Refresh active security snapshots failed", None, Some(&error)),
    }
    match refresh_cpi_snapshots().await {
        Ok(counts) => logger::info("Refreshed CPI snapshots", Some(&counts)),
        Err(error) => logger::error("Refresh CPI snapshots failed", None, Some(&error)),
    }
    Ok(())
}

async fn run_sync() {
    run_sync_guarded(&IS_SYNCING, run_jobs(), |detail| {
        tokio::spawn(async move { send_alarm("Scheduled Sync Failed", &detail, None, false).await });
    })
    .await;
}

/// Runs `jobs` unless a run is still going (`is_syncing`), logging the start
/// and the end; a failure is logged and alarmed through `alarm`.
async fn run_sync_guarded(is_syncing: &AtomicBool, jobs: impl Future<Output = anyhow::Result<()>>, alarm: impl FnOnce(String)) {
    if is_syncing.swap(true, Ordering::SeqCst) {
        logger::warn("Skipping scheduled sync — previous sync still running", None, None);
        return;
    }
    logger::info("Scheduled sync started", None);
    if let Err(error) = jobs.await {
        logger::error("Error occurred during scheduled sync", None, Some(&error));
        alarm(format!("**Error:** {error}"));
    }
    is_syncing.store(false, Ordering::SeqCst);
    logger::info("Scheduled sync completed", None);
}

/// Starts the hourly sync: runs it once now, then every hour. A run due while
/// the previous one is still going is skipped.
pub fn scheduled_sync() {
    tokio::spawn(run_sync());
    let timer = tokio::spawn(async {
        let mut ticker = tokio::time::interval_at(Instant::now() + SYNC_INTERVAL, SYNC_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            tokio::spawn(run_sync());
        }
    });
    if let Some(previous) = SYNC_TIMER.lock().unwrap().replace(timer) {
        previous.abort();
    }
}

/// Cancels the hourly sync. Called during graceful shutdown.
pub fn stop_scheduled_sync() {
    if let Some(timer) = SYNC_TIMER.lock().unwrap().take() {
        timer.abort();
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex as StdMutex;

    use serde_json::json;

    use super::*;

    /// Scripted answers per call, and a record of every call, in order.
    #[derive(Default)]
    struct Fake {
        plaid_configured: bool,
        items: StdMutex<Option<anyhow::Result<Vec<Json>>>>,
        accounts: StdMutex<VecDeque<anyhow::Result<Option<SyncAccountsResult>>>>,
        transactions: StdMutex<VecDeque<anyhow::Result<Option<SyncTransactionsResult>>>>,
        simple_fin: StdMutex<VecDeque<anyhow::Result<Option<SyncSimpleFinResult>>>>,
        calls: StdMutex<Vec<String>>,
        statuses: StdMutex<Vec<(String, bool, Option<String>)>>,
        alarms: StdMutex<Vec<(String, String)>>,
    }

    impl Fake {
        fn configured(items: Vec<Json>) -> Self {
            Fake { plaid_configured: true, items: StdMutex::new(Some(Ok(items))), ..Default::default() }
        }
        fn record(&self, call: String) {
            self.calls.lock().unwrap().push(call);
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl ItemSyncDeps for Fake {
        fn is_plaid_configured(&self) -> bool {
            self.plaid_configured
        }
        async fn get_all_items(&self) -> anyhow::Result<Vec<Json>> {
            self.items.lock().unwrap().take().unwrap_or_else(|| Ok(Vec::new()))
        }
        async fn sync_plaid_accounts(&self, item_id: &str) -> anyhow::Result<Option<SyncAccountsResult>> {
            self.record(format!("accounts {item_id}"));
            self.accounts.lock().unwrap().pop_front().unwrap_or_else(|| Ok(Some(SyncAccountsResult::default())))
        }
        async fn sync_plaid_transactions(&self, item_id: &str) -> anyhow::Result<Option<SyncTransactionsResult>> {
            self.record(format!("transactions {item_id}"));
            self.transactions.lock().unwrap().pop_front().unwrap_or_else(|| {
                Ok(Some(SyncTransactionsResult { user_id: "u".into(), added: 0, modified: 0, removed: 0 }))
            })
        }
        async fn sync_simple_fin_data(&self, item_id: &str) -> anyhow::Result<Option<SyncSimpleFinResult>> {
            self.record(format!("simple_fin {item_id}"));
            self.simple_fin.lock().unwrap().pop_front().unwrap_or_else(|| Ok(Some(SyncSimpleFinResult::default())))
        }
        async fn update_item_sync_status(&self, item_id: &str, result: &SyncResult) -> anyhow::Result<bool> {
            self.statuses.lock().unwrap().push((item_id.to_string(), result.success, result.error.clone()));
            Ok(true)
        }
        fn send_alarm(&self, title: &'static str, detail: String) {
            self.alarms.lock().unwrap().push((title.to_string(), detail));
        }
    }

    fn item(item_id: &str, provider: &str) -> Json {
        json!({ "item_id": item_id, "provider": provider })
    }

    #[tokio::test]
    async fn syncs_a_plaid_item_accounts_then_transactions() {
        let fake = Fake::configured(vec![item("item-plaid-1", "plaid")]);
        sync_items_with(&fake).await.unwrap();
        assert_eq!(fake.calls(), ["accounts item-plaid-1", "transactions item-plaid-1"]);
        assert_eq!(*fake.statuses.lock().unwrap(), [("item-plaid-1".to_string(), true, None)]);
        assert!(fake.alarms.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn skips_the_transactions_when_the_accounts_fail() {
        let fake = Fake::configured(vec![item("item-plaid-2", "plaid")]);
        fake.accounts.lock().unwrap().push_back(Err(anyhow::anyhow!("accounts boom")));
        sync_items_with(&fake).await.unwrap();
        assert_eq!(fake.calls(), ["accounts item-plaid-2"]);
        assert_eq!(
            *fake.alarms.lock().unwrap(),
            [(
                "Scheduled Sync Error: Plaid accounts failed".to_string(),
                "**Item:** item-plaid-2\n**Error:** accounts boom".to_string()
            )]
        );
        assert_eq!(*fake.statuses.lock().unwrap(), [("item-plaid-2".to_string(), false, Some("accounts boom".to_string()))]);
    }

    #[tokio::test]
    async fn records_the_error_when_the_transactions_fail() {
        let fake = Fake::configured(vec![item("item-plaid-3", "plaid")]);
        fake.transactions.lock().unwrap().push_back(Err(anyhow::anyhow!("txn fail")));
        sync_items_with(&fake).await.unwrap();
        assert_eq!(fake.calls(), ["accounts item-plaid-3", "transactions item-plaid-3"]);
        assert_eq!(fake.alarms.lock().unwrap()[0].0, "Scheduled Sync Error: Plaid transactions failed");
        assert_eq!(*fake.statuses.lock().unwrap(), [("item-plaid-3".to_string(), false, Some("txn fail".to_string()))]);
    }

    #[tokio::test]
    async fn an_item_the_accounts_sync_does_not_find_alarms_and_skips_the_transactions() {
        let fake = Fake::configured(vec![item("item-null", "plaid")]);
        fake.accounts.lock().unwrap().push_back(Ok(None));
        sync_items_with(&fake).await.unwrap();
        assert_eq!(fake.calls(), ["accounts item-null"]);
        assert_eq!(
            *fake.alarms.lock().unwrap(),
            [(
                "Scheduled Sync Error: Plaid accounts failed".to_string(),
                "**Item:** item-null\n**Error:** Error occured during syncAllPlaidAccounts".to_string()
            )]
        );
    }

    #[tokio::test]
    async fn syncs_a_simple_fin_item_and_records_its_failure() {
        let fake = Fake::configured(vec![item("item-sf-1", "simple_fin"), item("item-sf-2", "simple_fin"), item("item-manual", "manual")]);
        fake.simple_fin.lock().unwrap().extend([Ok(Some(SyncSimpleFinResult::default())), Err(anyhow::anyhow!("sf boom"))]);
        sync_items_with(&fake).await.unwrap();
        assert_eq!(fake.calls(), ["simple_fin item-sf-1", "simple_fin item-sf-2"]);
        assert_eq!(
            *fake.statuses.lock().unwrap(),
            [("item-sf-1".to_string(), true, None), ("item-sf-2".to_string(), false, Some("sf boom".to_string()))]
        );
        assert_eq!(fake.alarms.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn without_plaid_configured_plaid_items_are_skipped_and_the_rest_synced() {
        let fake = Fake { plaid_configured: false, ..Fake::configured(vec![item("item-plaid-1", "plaid"), item("item-sf", "simple_fin")]) };
        sync_items_with(&fake).await.unwrap();
        assert_eq!(fake.calls(), ["simple_fin item-sf"]);
        assert_eq!(*fake.statuses.lock().unwrap(), [("item-sf".to_string(), true, None)]);
    }

    #[tokio::test]
    async fn a_failed_item_list_fails_the_sync() {
        let fake = Fake { items: StdMutex::new(Some(Err(anyhow::anyhow!("db down")))), ..Fake::configured(Vec::new()) };
        assert_eq!(sync_items_with(&fake).await.unwrap_err().to_string(), "db down");
    }

    #[tokio::test]
    async fn an_error_with_an_empty_message_records_success_and_still_syncs_the_transactions() {
        let fake = Fake::configured(vec![item("item-empty", "plaid")]);
        fake.accounts.lock().unwrap().push_back(Err(anyhow::anyhow!("")));
        sync_items_with(&fake).await.unwrap();
        assert_eq!(fake.calls(), ["accounts item-empty", "transactions item-empty"]);
        assert_eq!(*fake.statuses.lock().unwrap(), [("item-empty".to_string(), true, Some(String::new()))]);
    }

    #[tokio::test]
    async fn a_failed_run_is_alarmed_and_the_guard_released() {
        let flag = AtomicBool::new(false);
        let alarms = StdMutex::new(Vec::new());
        run_sync_guarded(&flag, async { Err(anyhow::anyhow!("db down")) }, |detail| alarms.lock().unwrap().push(detail)).await;
        assert_eq!(*alarms.lock().unwrap(), ["**Error:** db down"]);
        assert!(!flag.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_run_due_while_the_previous_one_is_still_going_is_skipped() {
        let flag = AtomicBool::new(false);
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let second_ran = AtomicBool::new(false);
        let first = run_sync_guarded(
            &flag,
            async {
                let _ = released.await;
                Ok(())
            },
            |_| {},
        );
        let second = async {
            tokio::task::yield_now().await;
            run_sync_guarded(
                &flag,
                async {
                    second_ran.store(true, Ordering::SeqCst);
                    Ok(())
                },
                |_| {},
            )
            .await;
            let _ = release.send(());
        };
        futures::join!(first, second);
        assert!(!second_ran.load(Ordering::SeqCst));
        assert!(!flag.load(Ordering::SeqCst));
    }
}
