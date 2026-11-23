//! Background data processing: `src/server/lib/compute-tools/`.

pub mod auto_suggest;
pub mod backfill_snapshots;
pub mod cash_holding;
pub mod create_snapshots;
pub mod detect_recurrings;
pub mod detect_transfers;
pub mod refresh_cpi_snapshots;
pub mod refresh_security_snapshots;
pub mod schedule;
pub mod sync_plaid;
pub mod sync_simple_fin;
