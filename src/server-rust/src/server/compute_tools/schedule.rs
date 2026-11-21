//! The hourly background sync: `src/server/lib/compute-tools/schedule.ts`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::server::logger;

static IS_SYNCING: AtomicBool = AtomicBool::new(false);

async fn run_sync() {
    if IS_SYNCING.swap(true, Ordering::SeqCst) {
        logger::warn("Skipping scheduled sync — previous sync still running", None, None);
        return;
    }
    logger::info("Scheduled sync started", None);
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
