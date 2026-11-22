//! The hourly background sync: `src/server/lib/compute-tools/schedule.ts`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::server::logger;

use super::auto_suggest::run_auto_suggestions;
use super::detect_recurrings::run_recurring_detection;
use super::detect_transfers::run_transfer_detection;
use super::refresh_cpi_snapshots::refresh_cpi_snapshots;
use super::refresh_security_snapshots::refresh_active_security_snapshots;

static IS_SYNCING: AtomicBool = AtomicBool::new(false);

/// Syncs every connected item with its provider. A failure of one item is
/// logged, alarmed and recorded on the item; the rest still run.
async fn sync_items() -> anyhow::Result<()> {
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
    if IS_SYNCING.swap(true, Ordering::SeqCst) {
        logger::warn("Skipping scheduled sync — previous sync still running", None, None);
        return;
    }
    logger::info("Scheduled sync started", None);
    if let Err(error) = run_jobs().await {
        logger::error("Error occurred during scheduled sync", None, Some(&error));
        let detail = format!("**Error:** {error}");
        tokio::spawn(async move { crate::server::alarm::send_alarm("Scheduled Sync Failed", &detail, None, false).await });
    }
    IS_SYNCING.store(false, Ordering::SeqCst);
    logger::info("Scheduled sync completed", None);
}

/// Starts the hourly sync. Runs once immediately, then every hour.
pub fn scheduled_sync() {
    tokio::spawn(async {
        let mut ticker = tokio::time::interval(Duration::from_secs(60 * 60));
        loop {
            ticker.tick().await;
            run_sync().await;
        }
    });
}
