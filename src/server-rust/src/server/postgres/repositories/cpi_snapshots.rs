//! `src/server/lib/postgres/repositories/cpi_snapshots.ts`.

use crate::filters;
use crate::js::{Json, Obj};
use crate::server::postgres::database::{QueryData, SearchFilters};
use crate::server::postgres::models::cpi_snapshot;

/// Every stored month of one CPI series, oldest first, each a
/// `JSONCpiSnapshot`. The table holds a few hundred rows per series at most
/// (the refresh keeps a bounded window), so a full read is cheaper than any
/// incremental bookkeeping would be.
pub async fn get_cpi_snapshots(series_id: &str) -> anyhow::Result<Vec<Json>> {
    let options = SearchFilters { order_by: Some("snapshot_date ASC".to_string()), ..Default::default() };
    let models = cpi_snapshot::TABLE.query(filters! { "series_id" => series_id }, options, None).await?;
    Ok(models.iter().map(cpi_snapshot::to_json).collect())
}

/// Upserts CPI months (each a `JSONCpiSnapshot`) in one round trip. Each
/// row's `updated` is reset to now, including rows whose value did not
/// change: the refresh cadence gate relies on that to space out re-fetches
/// while it waits for BLS to publish a month. Returns the number of rows
/// written.
pub async fn upsert_cpi_snapshots(snapshots: &[Obj]) -> anyhow::Result<usize> {
    if snapshots.is_empty() {
        return Ok(0);
    }
    let rows: Vec<QueryData> = snapshots.iter().map(cpi_snapshot::from_json).collect::<anyhow::Result<_>>()?;
    let written = cpi_snapshot::TABLE.upsert_many(&rows, None, None).await?;
    Ok(written.len())
}
