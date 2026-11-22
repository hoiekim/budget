//! `src/server/lib/postgres/repositories/snapshots.ts`.

use std::collections::HashMap;

use futures::stream::{self, BoxStream};
use futures::StreamExt;
use serde_json::json;

use super::securities::search_securities_by_id;
use crate::filters;
use crate::server::postgres::database::shared_with;
use crate::js::{to_js_string, truthy_opt, Json, Obj};
use crate::server::logger;
use crate::server::postgres::client::Executor;
use crate::server::postgres::database::{error_result, success_result, DateRange, Filters, QueryData, SearchFilters, UpsertResult};
use crate::server::postgres::models::snapshot::{self, SnapshotType};
use crate::server::postgres::models::{MaskedUser, Row, STREAM_BATCH_SIZE};

/// What `search_snapshots` narrows its answer by. The dates bound `updated`.
#[derive(Clone, Debug, Default)]
pub struct SearchSnapshotsOptions {
    pub account_id: Option<String>,
    pub account_ids: Option<Vec<String>>,
    pub security_id: Option<String>,
    pub snapshot_type: Option<SnapshotType>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// When true, soft-deleted (`is_deleted = TRUE`) rows are INCLUDED in the
    /// answer so the client can treat them as tombstones and evict them from
    /// its local cache. Consumers that expect active rows only leave it false.
    pub include_deleted: bool,
}

/// `SecuritySnapshot`: `snapshot_id`, `snapshot_date`, `security_id` and,
/// when the row has one, `close_price`.
pub type SecuritySnapshot = Obj;

/// `HoldingSnapshot`: `snapshot_id`, `snapshot_date`, `holding_account_id`,
/// `holding_security_id` and any of `institution_price`, `institution_value`,
/// `cost_basis` and `quantity`. An amount that is absent is not known (and
/// not written); one that is `null` is written as NULL.
pub type HoldingSnapshot = Obj;

/// Batches of rows, as `Table::query_in_batches` yields them.
type RowBatches = BoxStream<'static, anyhow::Result<Vec<Row>>>;

/// Batches of `JSONSnapshotData`, as `search_snapshots` yields them.
pub type SnapshotBatches = BoxStream<'static, anyhow::Result<Vec<Json>>>;

/// A string option that is given and not empty, which is what the TypeScript's truthiness checks ask.
fn given(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|value| !value.is_empty())
}

/// `start || end ? { column, start, end } : undefined`.
fn date_range(column: &str, start: &Option<String>, end: &Option<String>) -> Option<DateRange> {
    (given(start) || given(end)).then(|| DateRange { column: column.to_string(), start: start.clone(), end: end.clone() })
}

/// The ids as an `IN` filter on `column`; no filter for an absent or empty list.
fn in_filter(column: &str, ids: &Option<Vec<String>>) -> Vec<(String, Vec<Json>)> {
    match ids {
        Some(ids) if !ids.is_empty() => vec![(column.to_string(), ids.iter().map(|id| json!(id)).collect())],
        _ => Vec::new(),
    }
}

/// One read of `search_snapshots`: the filters and options of a `Table::query_in_batches`.
type Read = (Filters, SearchFilters);

/// The reads `search_snapshots` makes for `options`, in the order it makes them.
struct SnapshotReads {
    /// The rows the user (or, with no user, anyone) owns.
    owned: Read,
    /// The user's holding snapshots of the accounts asked for.
    holdings_by_account: Option<Read>,
    /// Security snapshots, which belong to no user.
    securities: Option<Read>,
}

fn snapshot_reads(user: Option<&MaskedUser>, options: &SearchSnapshotsOptions) -> SnapshotReads {
    // Filter by `updated`, not `snapshot_date`, as the transactions
    // repository does. Soft-deletes and edits bump `updated`, so the client's
    // delta-by-cursor sync surfaces them regardless of which month the
    // snapshot is originally dated to. Filtering on `snapshot_date` would
    // never include a snapshot whose row moved (deletion, re-dating) but
    // whose original date is outside the cursor's window.
    let date_range = date_range("updated", &options.start_date, &options.end_date);
    let exclude_deleted = Some(!options.include_deleted);
    let user_id = user.map(shared_with);
    let has_account_ids = options.account_ids.as_ref().is_some_and(|ids| !ids.is_empty());

    let mut filters = Filters::new();
    if let Some(snapshot_type) = options.snapshot_type {
        filters.extend(filters! { "snapshot_type" => snapshot_type.as_str() });
    }
    if let Some(account_id) = &options.account_id {
        filters.extend(filters! { "account_id" => account_id.as_str() });
    }
    if let Some(security_id) = &options.security_id {
        filters.extend(filters! { "security_id" => security_id.as_str() });
    }
    let owned = (
        filters,
        SearchFilters {
            user_id: user_id.clone(),
            in_filters: in_filter("account_id", &options.account_ids),
            date_range: date_range.clone(),
            exclude_deleted,
            ..Default::default()
        },
    );

    // Holding snapshots store the account in `holding_account_id` and leave
    // `account_id` NULL, so the `account_id`-filtered read above never
    // returns them. When the caller narrows by account (single or list) AND
    // the requested type is `holding` or unspecified, a second read keyed on
    // `holding_account_id` follows.
    //
    // Without it the client has no holding snapshots at all (its sync asks
    // per account, month-sliced), which silently breaks Holdings Composition,
    // Investment Performance's snapshot anchor, and the holding-snapshot
    // balance fallback.
    let wants_holding_by_account = matches!(options.snapshot_type, None | Some(SnapshotType::Holding))
        && (given(&options.account_id) || has_account_ids);
    let holdings_by_account = wants_holding_by_account.then(|| {
        let mut filters = filters! { "snapshot_type" => SnapshotType::Holding.as_str() };
        if let Some(account_id) = &options.account_id {
            filters.extend(filters! { "holding_account_id" => account_id.as_str() });
        }
        // Holding rows store the security in `holding_security_id`; the
        // `security_id` column is NULL for them. Filtering by `security_id`
        // here would match no rows.
        if let Some(security_id) = &options.security_id {
            filters.extend(filters! { "holding_security_id" => security_id.as_str() });
        }
        (
            filters,
            SearchFilters {
                user_id: user_id.clone(),
                in_filters: in_filter("holding_account_id", &options.account_ids),
                date_range: date_range.clone(),
                exclude_deleted,
                ..Default::default()
            },
        )
    });

    // Security snapshots only make sense when the caller isn't narrowing to a
    // specific account or to another snapshot type. That read is skipped in
    // those cases, to keep the answer's shape consistent with the request.
    let wants_security = matches!(options.snapshot_type, None | Some(SnapshotType::Security))
        && !given(&options.account_id)
        && !has_account_ids;
    let securities = wants_security.then(|| {
        let mut filters = filters! { "snapshot_type" => SnapshotType::Security.as_str() };
        if let Some(security_id) = &options.security_id {
            filters.extend(filters! { "security_id" => security_id.as_str() });
        }
        (filters, SearchFilters { date_range: date_range.clone(), exclude_deleted, ..Default::default() })
    });

    SnapshotReads { owned, holdings_by_account, securities }
}

fn read_in_batches((filters, options): Read) -> RowBatches {
    snapshot::TABLE.query_in_batches(filters, options, STREAM_BATCH_SIZE)
}

/// `toJSONBatches` of `models/base.ts`, for snapshot rows.
fn to_json_batches(batches: RowBatches) -> SnapshotBatches {
    Box::pin(batches.map(|batch| batch.map(|models| models.iter().map(snapshot::to_json).collect())))
}

/// The securities of `models` that `known` lacks, each once, in the order met.
fn missing_security_ids(models: &[Row], known: &HashMap<String, Obj>) -> Vec<String> {
    let mut missing: Vec<String> = Vec::new();
    for model in models {
        let Some(id) = model.get("security_id").and_then(|id| id.as_str()) else { continue };
        if !id.is_empty() && !known.contains_key(id) && !missing.iter().any(|seen| seen == id) {
            missing.push(id.to_string());
        }
    }
    missing
}

/// A security snapshot with the whole record of its security, where `known`
/// has it. The snapshot keeps its own historical `close_price` (per
/// `snapshot_date`): the securities table only holds the latest price.
fn with_security(mut snap: Json, known: &HashMap<String, Obj>) -> Json {
    let Some(security) = snap.get_mut("security") else { return snap };
    let Some(record) = security.get("security_id").and_then(|id| id.as_str()).and_then(|id| known.get(id)) else { return snap };
    let mut enriched = record.clone();
    match security.get("close_price") {
        Some(close_price) => enriched.insert("close_price".to_string(), close_price.clone()),
        None => enriched.shift_remove("close_price"),
    };
    *security = Json::Object(enriched);
    snap
}

/// Security snapshots as JSON, each enriched with `ticker_symbol`, `name`,
/// `type` and the rest from the securities table. Without this the client's
/// security snapshots would carry only `{ security_id, close_price }` and it
/// couldn't resolve a `security_id` to a ticker. Securities are few, so each
/// one is looked up once and reused across batches.
fn with_securities(batches: RowBatches) -> SnapshotBatches {
    struct State {
        batches: RowBatches,
        securities: HashMap<String, Obj>,
    }
    Box::pin(stream::unfold(State { batches, securities: HashMap::new() }, |mut state| async move {
        let models = match state.batches.next().await? {
            Ok(models) => models,
            Err(error) => return Some((Err(error), state)),
        };
        let missing_ids = missing_security_ids(&models, &state.securities);
        if !missing_ids.is_empty() {
            match search_securities_by_id(&missing_ids).await {
                Ok(found) => {
                    for security in found {
                        let Json::Object(security) = security else { continue };
                        let Some(id) = security.get("security_id").and_then(|id| id.as_str()).map(str::to_string) else { continue };
                        state.securities.insert(id, security);
                    }
                }
                Err(error) => return Some((Err(error), state)),
            }
        }
        let batch = models.iter().map(|model| with_security(snapshot::to_json(model), &state.securities)).collect();
        Some((Ok(batch), state))
    }))
}

/// Ends `batches` at its first error, the way a generator that throws yields nothing more.
fn until_error(batches: SnapshotBatches) -> SnapshotBatches {
    Box::pin(stream::unfold((batches, false), |(mut batches, failed)| async move {
        if failed {
            return None;
        }
        let batch = batches.next().await?;
        let failed = batch.is_err();
        Some((batch, (batches, failed)))
    }))
}

/// The snapshots `options` ask for, one batch of `JSONSnapshotData` at a
/// time. Nothing is read until the stream is polled, and it ends at the
/// first read that fails.
///
/// Security snapshots are price data, stored with `user_id = NULL` because
/// they're shared across all users. The user-scoped read would exclude them
/// by its `user_id = $1` filter, leaving the client unable to resolve a
/// `security_id` to a ticker.
///
/// Separate reads instead of one: `Table::query_in_batches` filters by a
/// single `user_id`, so it can't express the `user_id = $1 OR user_id IS NULL`
/// union that surfacing shared security rows alongside the user's own
/// requires. The scoped reads are yielded one after the other.
pub fn search_snapshots(user: Option<&MaskedUser>, options: SearchSnapshotsOptions) -> SnapshotBatches {
    let reads = snapshot_reads(user, &options);
    let mut batches = to_json_batches(read_in_batches(reads.owned));
    if let Some(read) = reads.holdings_by_account {
        batches = Box::pin(batches.chain(to_json_batches(read_in_batches(read))));
    }
    if let Some(read) = reads.securities {
        batches = Box::pin(batches.chain(with_securities(read_in_batches(read))));
    }
    until_error(batches)
}

/// The filters of `get_security_snapshots`; the dates bound `snapshot_date`.
#[derive(Clone, Debug, Default)]
pub struct SecuritySnapshotsOptions {
    pub security_id: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

/// `row[column]` into `object`, unless the row has nothing (`null`) there.
fn copy_unless_null(object: &mut Obj, row: &Row, column: &str) {
    if let Some(value) = row.get(column).filter(|value| !value.is_null()) {
        object.insert(column.to_string(), value.clone());
    }
}

/// `row[column]` into `object`, `null` included.
fn copy(object: &mut Obj, row: &Row, column: &str) {
    if let Some(value) = row.get(column) {
        object.insert(column.to_string(), value.clone());
    }
}

pub async fn get_security_snapshots(options: SecuritySnapshotsOptions) -> anyhow::Result<Vec<SecuritySnapshot>> {
    let mut filters = filters! { "snapshot_type" => SnapshotType::Security.as_str() };
    if let Some(security_id) = &options.security_id {
        filters.extend(filters! { "security_id" => security_id.as_str() });
    }
    let snapshots = snapshot::TABLE
        .query(
            filters,
            SearchFilters {
                date_range: date_range("snapshot_date", &options.start_date, &options.end_date),
                order_by: Some("snapshot_date".to_string()),
                ..Default::default()
            },
            None,
        )
        .await?;

    Ok(snapshots
        .iter()
        .map(|s| {
            let mut snapshot = Obj::new();
            copy(&mut snapshot, s, "snapshot_id");
            copy(&mut snapshot, s, "snapshot_date");
            copy(&mut snapshot, s, "security_id");
            copy_unless_null(&mut snapshot, s, "close_price");
            snapshot
        })
        .collect())
}

/// Row to `HoldingSnapshot`, the field conversions every holding-snapshot
/// accessor applies per row. Shared so they cannot drift apart.
fn to_holding_snapshot(s: &Row) -> HoldingSnapshot {
    let mut snapshot = Obj::new();
    copy(&mut snapshot, s, "snapshot_id");
    copy(&mut snapshot, s, "snapshot_date");
    copy(&mut snapshot, s, "holding_account_id");
    copy(&mut snapshot, s, "holding_security_id");
    copy_unless_null(&mut snapshot, s, "institution_price");
    copy_unless_null(&mut snapshot, s, "institution_value");
    copy_unless_null(&mut snapshot, s, "cost_basis");
    copy_unless_null(&mut snapshot, s, "quantity");
    snapshot
}

/// The filters of `get_holding_snapshots`; one that is absent or empty is
/// not applied. The dates bound `snapshot_date`.
#[derive(Clone, Debug, Default)]
pub struct HoldingSnapshotsOptions {
    pub account_id: Option<String>,
    pub security_id: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

pub async fn get_holding_snapshots(user: &MaskedUser, options: HoldingSnapshotsOptions) -> anyhow::Result<Vec<HoldingSnapshot>> {
    let mut filters = filters! { "snapshot_type" => SnapshotType::Holding.as_str() };
    if let Some(account_id) = options.account_id.as_deref().filter(|account_id| !account_id.is_empty()) {
        filters.extend(filters! { "holding_account_id" => account_id });
    }
    if let Some(security_id) = options.security_id.as_deref().filter(|security_id| !security_id.is_empty()) {
        filters.extend(filters! { "holding_security_id" => security_id });
    }

    let snapshots = snapshot::TABLE
        .query(
            filters,
            SearchFilters {
                user_id: Some(shared_with(user)),
                date_range: date_range("snapshot_date", &options.start_date, &options.end_date),
                order_by: Some("snapshot_date".to_string()),
                ..Default::default()
            },
            None,
        )
        .await?;

    Ok(snapshots.iter().map(to_holding_snapshot).collect())
}

/// One holding snapshot by primary key, user-scoped. The key is filtered on
/// by the database (which, as for `query`, leaves out soft-deleted rows), so
/// a lookup that finds nothing answers `None`: the caller's "not found or
/// access denied".
pub async fn get_holding_snapshot_by_id(user: &MaskedUser, snapshot_id: &str) -> anyhow::Result<Option<HoldingSnapshot>> {
    let row = snapshot::TABLE
        .query_one(filters! {
            "snapshot_id" => snapshot_id,
            "snapshot_type" => SnapshotType::Holding.as_str(),
            "user_id" => shared_with(user),
        })
        .await?;
    Ok(row.as_ref().map(to_holding_snapshot))
}

/// A row being written: a column whose value is `undefined` is left out.
#[derive(Default)]
struct Columns(QueryData);

impl Columns {
    fn set(mut self, column: &str, value: impl Into<Json>) -> Self {
        self.0.insert(column.to_string(), value.into());
        self
    }

    fn opt(mut self, column: &str, value: Option<&Json>) -> Self {
        if let Some(value) = value {
            self.0.insert(column.to_string(), value.clone());
        }
        self
    }
}

/// Columns a holding-snapshot conflict may rewrite. `snapshot_id` is minted
/// from a caller-supplied `account_id`, so without an allowlist `Table::upsert`
/// defaults to every supplied key and a colliding id reassigns the row's owner.
const HOLDING_SNAPSHOT_UPDATE_COLUMNS: &[&str] = &[
    "snapshot_date",
    "is_deleted",
    "holding_security_id",
    "institution_price",
    "institution_value",
    "cost_basis",
    "quantity",
];

/// The row `upsert_holding_snapshots` writes for one snapshot.
fn holding_snapshot_row(user: &MaskedUser, snapshot: &HoldingSnapshot) -> QueryData {
    Columns::default()
        .opt("snapshot_id", snapshot.get("snapshot_id"))
        .set("user_id", user.user_id.as_str())
        .opt("snapshot_date", snapshot.get("snapshot_date"))
        .set("snapshot_type", SnapshotType::Holding.as_str())
        .set("is_deleted", false)
        .opt("holding_account_id", snapshot.get("holding_account_id"))
        .opt("holding_security_id", snapshot.get("holding_security_id"))
        .opt("institution_price", snapshot.get("institution_price"))
        .opt("institution_value", snapshot.get("institution_value"))
        .opt("cost_basis", snapshot.get("cost_basis"))
        .opt("quantity", snapshot.get("quantity"))
        .0
}

/// Writes each holding snapshot as the user's, reporting one result per
/// snapshot: a failed write is logged and answers 500 for that snapshot alone.
pub async fn upsert_holding_snapshots(user: &MaskedUser, snapshots: &[HoldingSnapshot]) -> Vec<UpsertResult> {
    let mut results = Vec::new();

    for snapshot in snapshots {
        let snapshot_id = snapshot.get("snapshot_id").map(to_js_string).unwrap_or_default();
        let row = holding_snapshot_row(user, snapshot);
        match snapshot::TABLE.upsert(&row, Some(HOLDING_SNAPSHOT_UPDATE_COLUMNS), None).await {
            Ok(_) => results.push(success_result(&snapshot_id, Some(1))),
            Err(error) => {
                logger::error(
                    "Failed to upsert holding snapshot",
                    Some(&crate::ctx! { "snapshotId": snapshot.get("snapshot_id") }),
                    Some(&error),
                );
                results.push(error_result(&snapshot_id));
            }
        }
    }
    results
}

/// The one option of `get_holding_snapshots_for_securities`: the executor to read on.
#[derive(Clone, Copy, Default)]
pub struct HoldingSnapshotsForSecuritiesOptions<'a> {
    pub client: Option<&'a dyn Executor>,
}

/// Live holding snapshots for some of an account's securities, in date order,
/// read on `client` when given.
pub async fn get_holding_snapshots_for_securities(
    user: &MaskedUser,
    account_id: &str,
    security_ids: &[String],
    options: HoldingSnapshotsForSecuritiesOptions<'_>,
) -> anyhow::Result<Vec<HoldingSnapshot>> {
    if security_ids.is_empty() {
        return Ok(Vec::new());
    }
    let snapshots = snapshot::TABLE
        .query(
            filters! { "snapshot_type" => SnapshotType::Holding.as_str(), "holding_account_id" => account_id },
            SearchFilters {
                user_id: Some(shared_with(user)),
                in_filters: vec![("holding_security_id".to_string(), security_ids.iter().map(|id| json!(id)).collect())],
                order_by: Some("snapshot_date, snapshot_id".to_string()),
                ..Default::default()
            },
            options.client,
        )
        .await?;
    Ok(snapshots.iter().map(to_holding_snapshot).collect())
}

/// Soft-deletes the caller's holding snapshots by id, so clients receive the tombstones.
pub async fn soft_delete_holding_snapshots(
    user: &MaskedUser,
    snapshot_ids: &[String],
    client: Option<&dyn Executor>,
) -> anyhow::Result<()> {
    if snapshot_ids.is_empty() {
        return Ok(());
    }
    let ids: Vec<Json> = snapshot_ids.iter().map(|snapshot_id| json!(snapshot_id)).collect();
    snapshot::TABLE.bulk_soft_delete(&ids, &[("user_id", shared_with(user))], client).await?;
    Ok(())
}

/// Columns an account-balance conflict may rewrite. `Table::upsert` otherwise
/// defaults to every supplied key, which lets a colliding `snapshot_id`
/// reassign the row's owner.
const ACCOUNT_SNAPSHOT_UPDATE_COLUMNS: &[&str] = &[
    "snapshot_date",
    "is_deleted",
    "balances_available",
    "balances_current",
    "balances_limit",
    "balances_iso_currency_code",
];

/// `object?.key`: a value that is `null`, absent or not an object has no properties.
fn prop<'a>(object: Option<&'a Json>, key: &str) -> Option<&'a Json> {
    object.and_then(|object| object.get(key))
}

/// The `account`, `security` or `holding` of a snapshot, for the property
/// reads that follow on it: an error where it is `null`, as reading a
/// property of `null` is in the TypeScript.
fn part<'a>(d: &'a Obj, key: &str, first_read: &str) -> anyhow::Result<Option<&'a Json>> {
    match d.get(key) {
        Some(Json::Null) => anyhow::bail!("null is not an object (evaluating '{key}.{first_read}')"),
        part => Ok(part),
    }
}

/// A row of `upsert_snapshots` and the columns a conflict may rewrite: `None` for every column the row has.
type SnapshotWrite = (QueryData, Option<&'static [&'static str]>);

/// What `upsert_snapshots` writes for one `JSONSnapshotData`. Nothing for
/// data that is neither an account, a security nor a holding snapshot.
fn snapshot_write(d: &Obj) -> anyhow::Result<Option<SnapshotWrite>> {
    let snapshot = d.get("snapshot");
    let user_id = prop(d.get("user"), "user_id");
    let row = Columns::default().opt("snapshot_id", prop(snapshot, "snapshot_id"));

    if snapshot::is_account_snapshot(d) {
        let account = part(d, "account", "account_id")?;
        let balances = prop(account, "balances");
        let row = row
            .opt("user_id", user_id)
            .opt("snapshot_date", prop(snapshot, "date"))
            .set("snapshot_type", SnapshotType::AccountBalance.as_str())
            .opt("account_id", prop(account, "account_id"))
            // Deletes are soft, so a re-add (or a date edit) that lands on a
            // previously deleted day updates the tombstoned row. Without this the
            // row keeps `is_deleted = TRUE`, the write "succeeds", and the next
            // delta sync reads it back as a tombstone and evicts it again.
            .set("is_deleted", false)
            .opt("balances_available", prop(balances, "available"))
            .opt("balances_current", prop(balances, "current"))
            .opt("balances_limit", prop(balances, "limit"))
            .opt("balances_iso_currency_code", prop(balances, "iso_currency_code"));
        Ok(Some((row.0, Some(ACCOUNT_SNAPSHOT_UPDATE_COLUMNS))))
    } else if snapshot::is_security_snapshot(d) {
        let security = part(d, "security", "security_id")?;
        let row = row
            .opt("snapshot_date", prop(snapshot, "date"))
            .set("snapshot_type", SnapshotType::Security.as_str())
            .opt("security_id", prop(security, "security_id"))
            .opt("close_price", prop(security, "close_price"));
        Ok(Some((row.0, None)))
    } else if snapshot::is_holding_snapshot(d) {
        let holding = part(d, "holding", "account_id")?;
        let row = row
            .opt("user_id", user_id)
            .opt("snapshot_date", prop(snapshot, "date"))
            .set("snapshot_type", SnapshotType::Holding.as_str())
            .set("is_deleted", false)
            .opt("holding_account_id", prop(holding, "account_id"))
            .opt("holding_security_id", prop(holding, "security_id"))
            .opt("institution_price", prop(holding, "institution_price"))
            .opt("institution_value", prop(holding, "institution_value"))
            .opt("cost_basis", prop(holding, "cost_basis"))
            .opt("quantity", prop(holding, "quantity"));
        Ok(Some((row.0, Some(HOLDING_SNAPSHOT_UPDATE_COLUMNS))))
    } else {
        Ok(None)
    }
}

/// Writes each `JSONSnapshotData` that has a snapshot id, reporting one
/// result per snapshot written: a failed write is logged and answers 500 for
/// that snapshot alone. Data without a snapshot id is skipped and reports
/// nothing.
pub async fn upsert_snapshots(snapshots: &[Obj]) -> Vec<UpsertResult> {
    let mut results = Vec::new();

    for snapshot_data in snapshots {
        let id = prop(snapshot_data.get("snapshot"), "snapshot_id");
        if !truthy_opt(id) {
            continue;
        }
        let snapshot_id = id.map(to_js_string).unwrap_or_default();

        let written = async {
            if let Some((row, update_columns)) = snapshot_write(snapshot_data)? {
                snapshot::TABLE.upsert(&row, update_columns, None).await?;
            }
            anyhow::Ok(())
        };
        match written.await {
            Ok(()) => results.push(success_result(&snapshot_id, Some(1))),
            Err(error) => {
                logger::error("Failed to upsert snapshot", Some(&crate::ctx! { "snapshotId": id }), Some(&error));
                results.push(error_result(&snapshot_id));
            }
        }
    }
    results
}

pub async fn delete_snapshot_by_id(user: &MaskedUser, snapshot_id: &str) -> anyhow::Result<bool> {
    snapshot::TABLE.soft_delete(&json!(snapshot_id), Some(shared_with(user))).await
}

#[cfg(test)]
mod tests {
    use super::super::items::testing::{obj, test_user, update_columns_of, FakeExecutor};
    use super::*;
    use crate::server::postgres::database::build_select_with_filters;

    /// The first statement `Table::query_in_batches` issues for a read.
    fn batch_sql((filters, options): Read) -> (String, Vec<Json>) {
        let search = SearchFilters {
            filters,
            order_by: Some("snapshot_id".to_string()),
            limit: Some(STREAM_BATCH_SIZE as i64),
            ..options
        };
        let query = build_select_with_filters("snapshots", "*", &search);
        (query.sql, query.values)
    }

    fn reads(options: SearchSnapshotsOptions) -> SnapshotReads {
        snapshot_reads(Some(&test_user()), &options)
    }

    fn text(value: &str) -> Option<String> {
        Some(value.to_string())
    }

    // `snapshots.test.ts`, "searchSnapshots".

    #[test]
    fn the_unfiltered_fetch_reads_the_users_rows_and_then_the_shared_security_rows() {
        let reads = reads(SearchSnapshotsOptions { start_date: text("2026-01-01"), ..Default::default() });
        assert!(reads.holdings_by_account.is_none());

        let (sql, values) = batch_sql(reads.owned);
        assert_eq!(
            sql,
            "SELECT * FROM snapshots WHERE user_id = ANY(sharing_user_ids($1)) AND updated >= $2 AND (is_deleted IS NULL OR is_deleted = FALSE) ORDER BY snapshot_id LIMIT $3"
        );
        assert_eq!(values, vec![json!("usr-1"), json!("2026-01-01"), json!(STREAM_BATCH_SIZE)]);

        let (sql, values) = batch_sql(reads.securities.unwrap());
        assert!(!sql.contains("user_id = "));
        assert!(sql.contains("snapshot_type = $1"));
        assert_eq!(values, vec![json!("security"), json!("2026-01-01"), json!(STREAM_BATCH_SIZE)]);
    }

    #[test]
    fn narrowing_to_an_account_skips_the_security_read_and_adds_the_holding_account_read() {
        let reads = reads(SearchSnapshotsOptions { account_id: text("acc-7"), ..Default::default() });
        assert!(reads.securities.is_none());
        assert!(batch_sql(reads.owned).1.contains(&json!("acc-7")));
        assert!(batch_sql(reads.holdings_by_account.unwrap()).0.contains("holding_account_id = "));
    }

    #[test]
    fn asking_for_holding_snapshots_alone_makes_one_read() {
        let reads = reads(SearchSnapshotsOptions { snapshot_type: Some(SnapshotType::Holding), ..Default::default() });
        assert!(reads.holdings_by_account.is_none());
        assert!(reads.securities.is_none());
        let (sql, values) = batch_sql(reads.owned);
        assert!(sql.contains("snapshot_type = "));
        assert!(values.contains(&json!("holding")));
    }

    #[test]
    fn a_list_of_accounts_skips_the_security_read_and_adds_the_holding_account_read() {
        let reads = reads(SearchSnapshotsOptions {
            account_ids: Some(vec!["acc-1".to_string(), "acc-2".to_string()]),
            ..Default::default()
        });
        assert!(reads.securities.is_none());
        let (sql, values) = batch_sql(reads.holdings_by_account.unwrap());
        assert!(sql.contains("holding_account_id IN ($3, $4)"));
        assert!(values.contains(&json!("acc-1")) && values.contains(&json!("acc-2")));
        assert!(batch_sql(reads.owned).0.contains("account_id IN ($2, $3)"));
    }

    #[test]
    fn an_empty_list_of_accounts_narrows_nothing() {
        let reads = reads(SearchSnapshotsOptions { account_ids: Some(Vec::new()), ..Default::default() });
        assert!(reads.holdings_by_account.is_none());
        assert!(reads.securities.is_some());
        assert!(!batch_sql(reads.owned).0.contains(" IN "));
    }

    #[test]
    fn asking_for_security_snapshots_reads_them_too() {
        let reads = reads(SearchSnapshotsOptions { snapshot_type: Some(SnapshotType::Security), ..Default::default() });
        assert!(reads.holdings_by_account.is_none());
        assert!(reads.securities.is_some());
    }

    #[test]
    fn the_date_range_reaches_every_read() {
        let options = SearchSnapshotsOptions { start_date: text("2026-01-01"), end_date: text("2026-06-30"), ..Default::default() };
        let all = reads(options.clone());
        let narrowed = reads(SearchSnapshotsOptions { account_id: text("acc-x"), ..options });
        for read in [all.owned, all.securities.unwrap(), narrowed.holdings_by_account.unwrap()] {
            let (sql, values) = batch_sql(read);
            assert!(sql.contains("updated >= ") && sql.contains("updated <= "));
            assert!(values.contains(&json!("2026-01-01")) && values.contains(&json!("2026-06-30")));
        }
    }

    #[test]
    fn the_security_id_filter_reaches_the_shared_security_read() {
        let reads = reads(SearchSnapshotsOptions { security_id: text("sec-aapl"), ..Default::default() });
        let (sql, values) = batch_sql(reads.securities.unwrap());
        assert!(sql.contains("security_id = "));
        assert!(values.contains(&json!("sec-aapl")));
    }

    #[test]
    fn tombstones_are_read_only_when_asked_for() {
        let live = reads(SearchSnapshotsOptions::default());
        assert!(batch_sql(live.owned).0.contains("(is_deleted IS NULL OR is_deleted = FALSE)"));
        assert!(batch_sql(live.securities.unwrap()).0.contains("(is_deleted IS NULL OR is_deleted = FALSE)"));

        let all = reads(SearchSnapshotsOptions { include_deleted: true, ..Default::default() });
        assert_eq!(batch_sql(all.owned).0, "SELECT * FROM snapshots WHERE user_id = ANY(sharing_user_ids($1)) ORDER BY snapshot_id LIMIT $2");
        assert_eq!(
            batch_sql(all.securities.unwrap()).0,
            "SELECT * FROM snapshots WHERE snapshot_type = $1 ORDER BY snapshot_id LIMIT $2"
        );
    }

    #[test]
    fn no_user_reads_every_owners_rows() {
        let reads = snapshot_reads(None, &SearchSnapshotsOptions::default());
        assert!(!batch_sql(reads.owned).0.contains("user_id"));
    }

    // `snapshots.test.ts`, "searchSnapshots — holding_account_id fallback".

    #[test]
    fn with_an_account_the_holding_read_is_keyed_on_holding_account_id_and_scoped_to_the_user() {
        let reads = reads(SearchSnapshotsOptions { account_id: text("acc-brokerage"), ..Default::default() });
        let (sql, values) = batch_sql(reads.holdings_by_account.unwrap());
        assert_eq!(
            sql,
            "SELECT * FROM snapshots WHERE user_id = ANY(sharing_user_ids($1)) AND snapshot_type = $2 AND holding_account_id = $3 AND (is_deleted IS NULL OR is_deleted = FALSE) ORDER BY snapshot_id LIMIT $4"
        );
        assert_eq!(values, vec![json!("usr-1"), json!("holding"), json!("acc-brokerage"), json!(STREAM_BATCH_SIZE)]);
    }

    #[test]
    fn asking_for_holding_snapshots_of_an_account_makes_the_holding_read() {
        let reads = reads(SearchSnapshotsOptions {
            snapshot_type: Some(SnapshotType::Holding),
            account_id: text("acc-x"),
            ..Default::default()
        });
        assert!(batch_sql(reads.holdings_by_account.unwrap()).0.contains("holding_account_id = "));
    }

    #[test]
    fn asking_for_account_balances_of_an_account_makes_one_read() {
        let reads = reads(SearchSnapshotsOptions {
            snapshot_type: Some(SnapshotType::AccountBalance),
            account_id: text("acc-x"),
            ..Default::default()
        });
        assert!(reads.holdings_by_account.is_none());
        assert!(reads.securities.is_none());
    }

    #[test]
    fn the_security_id_filter_targets_holding_security_id_in_the_holding_read() {
        // Holding rows store the security in `holding_security_id`; the
        // `security_id` column is NULL for them. Filtering the holding read
        // by `security_id =` would always match no rows.
        let reads = reads(SearchSnapshotsOptions { account_id: text("acc-x"), security_id: text("sec-voo"), ..Default::default() });
        let (sql, values) = batch_sql(reads.holdings_by_account.unwrap());
        let security_segment = sql.split(" AND ").find(|segment| segment.contains("security_id =")).unwrap();
        assert!(security_segment.contains("holding_security_id"));
        assert!(values.contains(&json!("sec-voo")));
    }

    // `snapshots.test.ts`, the enrichment cases of "searchSnapshots".

    fn security_row(snapshot_id: &str, security_id: Json) -> Row {
        let row = obj(json!({
            "snapshot_id": snapshot_id,
            "user_id": null,
            "snapshot_date": "2026-05-10",
            "snapshot_type": "security",
            "account_id": null,
            "balances_available": null,
            "balances_current": null,
            "balances_limit": null,
            "balances_iso_currency_code": null,
            "security_id": security_id,
            "close_price": 195.5,
            "holding_account_id": null,
            "holding_security_id": null,
            "institution_price": null,
            "institution_value": null,
            "cost_basis": null,
            "quantity": null,
            "updated": null,
            "is_deleted": false,
        }));
        snapshot::TABLE.validate(row).unwrap()
    }

    fn known(securities: Json) -> HashMap<String, Obj> {
        let Json::Array(securities) = securities else { panic!("not a list") };
        securities.into_iter().map(|security| (security["security_id"].as_str().unwrap().to_string(), obj(security))).collect()
    }

    #[test]
    fn a_security_snapshot_takes_the_securitys_record_and_keeps_its_own_close_price() {
        let securities = known(json!([{
            "security_id": "sec-aapl",
            "name": "Apple Inc.",
            "ticker_symbol": "AAPL",
            "type": "equity",
            "close_price": 200,
            "close_price_as_of": "2026-05-13",
        }]));
        let snap = with_security(snapshot::to_json(&security_row("snap-sec-1", json!("sec-aapl"))), &securities);
        assert_eq!(
            crate::js::json_stringify(&snap),
            concat!(
                r#"{"snapshot":{"snapshot_id":"snap-sec-1","date":"2026-05-10","is_deleted":false},"#,
                r#""security":{"security_id":"sec-aapl","name":"Apple Inc.","ticker_symbol":"AAPL","type":"equity","#,
                r#""close_price":195.5,"close_price_as_of":"2026-05-13"}}"#
            )
        );
    }

    #[test]
    fn a_security_snapshot_with_no_matching_security_is_left_as_it_is() {
        let snap = with_security(snapshot::to_json(&security_row("snap-sec-1", json!("sec-orphan"))), &HashMap::new());
        assert_eq!(snap["security"], json!({ "security_id": "sec-orphan", "close_price": 195.5 }));
    }

    #[test]
    fn each_security_is_looked_up_once_however_many_snapshots_and_batches_name_it() {
        let batch = [
            security_row("snap-1", json!("sec-aapl")),
            security_row("snap-2", json!("sec-aapl")),
            security_row("snap-3", json!("sec-msft")),
            security_row("snap-4", Json::Null),
        ];
        assert_eq!(missing_security_ids(&batch, &HashMap::new()), ["sec-aapl", "sec-msft"]);

        // A later batch asks only for what the earlier ones did not find.
        let found = known(json!([{ "security_id": "sec-aapl" }]));
        assert_eq!(missing_security_ids(&batch, &found), ["sec-msft"]);
        assert!(missing_security_ids(&[], &found).is_empty());
    }

    #[tokio::test]
    async fn a_failed_read_ends_the_stream() {
        let batches: SnapshotBatches = Box::pin(stream::iter(vec![
            Ok(vec![json!(1)]),
            Err(anyhow::anyhow!("read failed")),
            Ok(vec![json!(2)]),
        ]));
        let yielded: Vec<anyhow::Result<Vec<Json>>> = until_error(batches).collect().await;
        assert_eq!(yielded.len(), 2);
        assert_eq!(yielded[0].as_ref().unwrap(), &vec![json!(1)]);
        assert_eq!(yielded[1].as_ref().unwrap_err().to_string(), "read failed");
    }

    // `snapshots.test.ts`, "upsertHoldingSnapshots conflict" and the two
    // "upsertSnapshots … conflict" groups: the statement `Table::upsert`
    // builds from the row and the allowlist each function hands it.

    async fn upsert_sql(row: &QueryData, update_columns: Option<&[&str]>) -> String {
        let client = FakeExecutor::default();
        snapshot::TABLE.upsert(row, update_columns, Some(&client)).await.unwrap();
        client.statements().remove(0)
    }

    fn attacker() -> MaskedUser {
        MaskedUser { user_id: "attacker".to_string(), username: "attacker".to_string() }
    }

    async fn holding_snapshot_sql() -> String {
        let snapshot = obj(json!({
            "snapshot_id": "holding-acct-A-sec-1-20260701",
            "snapshot_date": "2026-07-01",
            "holding_account_id": "acct-A",
            "holding_security_id": "sec-1",
            "quantity": 999,
            "cost_basis": 1,
            "institution_price": 1,
            "institution_value": 999,
        }));
        upsert_sql(&holding_snapshot_row(&attacker(), &snapshot), Some(HOLDING_SNAPSHOT_UPDATE_COLUMNS)).await
    }

    const POSITION_COLUMNS: [&str; 7] =
        ["snapshot_date", "is_deleted", "holding_security_id", "institution_price", "institution_value", "cost_basis", "quantity"];

    #[tokio::test]
    async fn a_holding_snapshot_conflict_rewrites_the_position_and_never_the_owner_the_account_or_the_type() {
        let sql = holding_snapshot_sql().await;
        let columns = update_columns_of(&sql);
        for column in ["user_id", "holding_account_id", "snapshot_type"] {
            assert!(!columns.contains(&column.to_string()), "{column}");
        }
        // The position is rewritten and the tombstone cleared.
        for column in POSITION_COLUMNS {
            assert!(columns.contains(&column.to_string()), "{column}");
        }
        // The owner is inserted on a first write.
        assert!(sql.split("DO UPDATE SET").next().unwrap().contains("user_id"));
    }

    #[test]
    fn a_holding_snapshot_writes_null_where_given_and_nothing_where_absent() {
        let snapshot = obj(json!({ "snapshot_id": "s-1", "snapshot_date": "2026-07-01", "cost_basis": null, "quantity": 0 }));
        let row = holding_snapshot_row(&test_user(), &snapshot);
        assert_eq!(
            crate::js::json_stringify(&Json::Object(row)),
            r#"{"snapshot_id":"s-1","user_id":"usr-1","snapshot_date":"2026-07-01","snapshot_type":"holding","is_deleted":false,"cost_basis":null,"quantity":0}"#
        );
    }

    async fn snapshot_data_sql(data: Json) -> String {
        let (row, update_columns) = snapshot_write(&obj(data)).unwrap().unwrap();
        upsert_sql(&row, update_columns).await
    }

    fn account_snapshot(balances: Json) -> Json {
        json!({
            "user": { "user_id": "attacker" },
            "snapshot": { "snapshot_id": "acct-A-20260701", "date": "2026-07-01" },
            "account": { "account_id": "acct-A", "balances": balances },
        })
    }

    #[tokio::test]
    async fn an_account_snapshot_conflict_rewrites_the_balances_given_and_never_the_owner_or_the_account() {
        let sql = snapshot_data_sql(account_snapshot(json!({ "current": 1, "available": 1, "iso_currency_code": "USD" }))).await;
        let columns = update_columns_of(&sql);
        for column in ["user_id", "account_id", "snapshot_type"] {
            assert!(!columns.contains(&column.to_string()), "{column}");
        }
        for column in ["balances_available", "balances_current", "balances_iso_currency_code", "is_deleted", "snapshot_date"] {
            assert!(columns.contains(&column.to_string()), "{column}");
        }
        // The fixture supplies no `limit`, so `balances_limit` never reaches the
        // INSERT column list. A SET entry for it would resolve `EXCLUDED` to the
        // column default and wipe the stored value.
        assert!(!columns.contains(&"balances_limit".to_string()));
        assert!(sql.split("DO UPDATE SET").next().unwrap().contains("user_id"));
    }

    #[tokio::test]
    async fn an_account_snapshot_conflict_rewrites_a_balance_the_caller_did_supply() {
        let sql =
            snapshot_data_sql(account_snapshot(json!({ "current": 1, "available": 1, "limit": 5, "iso_currency_code": "USD" }))).await;
        assert!(update_columns_of(&sql).contains(&"balances_limit".to_string()));
    }

    #[tokio::test]
    async fn a_holding_snapshot_data_conflict_rewrites_the_position_and_never_the_owner_the_account_or_the_type() {
        let sql = snapshot_data_sql(json!({
            "user": { "user_id": "attacker" },
            "snapshot": { "snapshot_id": "holding-acct-A-sec-1-20260701", "date": "2026-07-01" },
            "holding": {
                "account_id": "acct-A",
                "security_id": "sec-1",
                "quantity": 999,
                "cost_basis": 1,
                "institution_price": 1,
                "institution_value": 999,
            },
        }))
        .await;
        let columns = update_columns_of(&sql);
        for column in ["user_id", "holding_account_id", "snapshot_type"] {
            assert!(!columns.contains(&column.to_string()), "{column}");
        }
        for column in POSITION_COLUMNS {
            assert!(columns.contains(&column.to_string()), "{column}");
        }
        assert!(sql.split("DO UPDATE SET").next().unwrap().contains("user_id"));
    }

    #[tokio::test]
    async fn a_security_snapshot_belongs_to_no_user_and_rewrites_every_column_it_carries() {
        let sql = snapshot_data_sql(json!({
            "snapshot": { "snapshot_id": "security-sec-1-20260701", "date": "2026-07-01" },
            "security": { "security_id": "sec-1", "close_price": 195.5 },
        }))
        .await;
        assert_eq!(
            sql,
            "INSERT INTO snapshots (updated, snapshot_id, snapshot_date, snapshot_type, security_id, close_price) VALUES (CURRENT_TIMESTAMP, $1, $2, $3, $4, $5) ON CONFLICT (snapshot_id) DO UPDATE SET snapshot_date = EXCLUDED.snapshot_date, snapshot_type = EXCLUDED.snapshot_type, security_id = EXCLUDED.security_id, close_price = EXCLUDED.close_price, updated = CURRENT_TIMESTAMP RETURNING *"
        );
    }

    #[test]
    fn snapshot_data_of_no_known_kind_writes_nothing_and_a_null_part_is_an_error() {
        let unknown = obj(json!({ "snapshot": { "snapshot_id": "s-1", "date": "2026-07-01" } }));
        assert!(snapshot_write(&unknown).unwrap().is_none());

        let null_account = obj(json!({ "snapshot": { "snapshot_id": "s-1" }, "account": null }));
        assert_eq!(
            snapshot_write(&null_account).unwrap_err().to_string(),
            "null is not an object (evaluating 'account.account_id')"
        );

        // An account that is not an object has no properties: the row has no account.
        let odd_account = obj(json!({ "snapshot": { "snapshot_id": "s-1" }, "account": "acct-A", "user": null }));
        let (row, _) = snapshot_write(&odd_account).unwrap().unwrap();
        let columns: Vec<&str> = row.keys().map(|column| column.as_str()).collect();
        assert_eq!(columns, ["snapshot_id", "snapshot_type", "is_deleted"]);
    }

    #[tokio::test]
    async fn empty_input_is_a_no_op() {
        let user = test_user();
        assert!(upsert_snapshots(&[]).await.is_empty());
        assert!(upsert_holding_snapshots(&user, &[]).await.is_empty());
        // Data with no snapshot id is skipped without a write or a result.
        let skipped = [obj(json!({ "account": { "account_id": "a" } })), obj(json!({ "snapshot": { "snapshot_id": "" }, "account": {} }))];
        assert!(upsert_snapshots(&skipped).await.is_empty());

        let client = FakeExecutor::default();
        let options = HoldingSnapshotsForSecuritiesOptions { client: Some(&client) };
        assert!(get_holding_snapshots_for_securities(&user, "acc-1", &[], options).await.unwrap().is_empty());
        soft_delete_holding_snapshots(&user, &[], Some(&client)).await.unwrap();
        assert!(client.calls().is_empty());
    }

    #[tokio::test]
    async fn the_holding_snapshots_of_some_securities_are_read_and_deleted_on_the_client_given() {
        let user = test_user();
        let client = FakeExecutor::default();
        let security_ids = ["sec-1".to_string(), "sec-2".to_string()];
        let options = HoldingSnapshotsForSecuritiesOptions { client: Some(&client) };
        get_holding_snapshots_for_securities(&user, "acc-1", &security_ids, options).await.unwrap();
        soft_delete_holding_snapshots(&user, &["snap-1".to_string()], Some(&client)).await.unwrap();

        let calls = client.calls();
        assert_eq!(
            calls[0].0,
            "SELECT * FROM snapshots WHERE user_id = ANY(sharing_user_ids($1)) AND snapshot_type = $2 AND holding_account_id = $3 AND holding_security_id IN ($4, $5) AND (is_deleted IS NULL OR is_deleted = FALSE) ORDER BY snapshot_date, snapshot_id"
        );
        assert_eq!(calls[0].1, vec![json!("usr-1"), json!("holding"), json!("acc-1"), json!("sec-1"), json!("sec-2")]);
        assert_eq!(
            calls[1].0,
            "UPDATE snapshots SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE snapshot_id IN ($1) AND user_id = ANY(sharing_user_ids($2)) RETURNING snapshot_id"
        );
        assert_eq!(calls[1].1, vec![json!("snap-1"), json!("usr-1")]);
    }

    #[test]
    fn a_holding_snapshot_leaves_out_the_amounts_the_row_does_not_have() {
        let mut row = security_row("holding-1", Json::Null);
        row.insert("snapshot_type".into(), json!("holding"));
        row.insert("holding_account_id".into(), json!("acc-1"));
        row.insert("holding_security_id".into(), json!("sec-1"));
        row.insert("quantity".into(), json!(0));
        row.insert("cost_basis".into(), json!(12.5));
        assert_eq!(
            crate::js::json_stringify(&Json::Object(to_holding_snapshot(&row))),
            r#"{"snapshot_id":"holding-1","snapshot_date":"2026-05-10","holding_account_id":"acc-1","holding_security_id":"sec-1","cost_basis":12.5,"quantity":0}"#
        );
    }
}
