//! What a bank sync writes: accounts, holdings and securities, each with the
//! snapshot that records the change: `src/server/lib/compute-tools/create-snapshots.ts`.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::json;

use crate::common::date::get_squashed_date_string;
use crate::common::utils::is_equal;
use crate::js::{self, JsDate, Json, Obj};
use crate::server::postgres::models::MaskedUser;
use crate::server::postgres::repositories::accounts::upsert_accounts;
use crate::server::postgres::repositories::holdings::{delete_holdings, upsert_holdings};
use crate::server::postgres::repositories::securities::upsert_securities;
use crate::server::postgres::repositories::snapshots::upsert_snapshots;

/// A template literal's text for a value: `undefined` when it is absent.
fn interpolate(value: Option<&Json>) -> String {
    value.map(js::to_js_string).unwrap_or_else(|| "undefined".to_string())
}

/// `Map.get`/`Set.has` key equality (SameValueZero) between two possibly absent values.
fn same_key(a: Option<&Json>, b: Option<&Json>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Json::Number(a)), Some(Json::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(a @ (Json::Null | Json::Bool(_) | Json::String(_))), Some(b)) => a == b,
        // Objects and arrays are keys by identity: one built from another row is never the same.
        _ => false,
    }
}

/// `new Map(rows.map((r) => [r[key], r])).get(value)`: the last row with that key.
fn last_by_key<'a>(rows: &'a [Obj], key: &str, value: Option<&Json>) -> Option<&'a Obj> {
    rows.iter().rev().find(|row| same_key(row.get(key), value))
}

/// `isEqual(x, y)` for two possibly absent values.
fn equal(x: Option<&Json>, y: Option<&Json>) -> bool {
    match (x, y) {
        (None, None) => true,
        (Some(x), Some(y)) => is_equal(x, y, false),
        _ => false,
    }
}

/// `{ snapshot_id: `${id}-${today}`, date: now }`, the snapshot of a change seen now.
fn snapshot_of_now(id: Option<&Json>) -> Json {
    let now = JsDate::now();
    json!({ "snapshot_id": format!("{}-{}", interpolate(id), get_squashed_date_string(now)), "date": now.to_json() })
}

fn into_obj(value: Json) -> Obj {
    match value {
        Json::Object(object) => object,
        _ => Obj::new(),
    }
}

/// The account-balance snapshots of a sync: one dated now for each incoming
/// account that is new or whose balances changed.
fn account_snapshots(user_id: &str, incoming_accounts: &[Obj], existing_accounts: &[Obj]) -> Vec<Obj> {
    incoming_accounts
        .iter()
        .filter(|a| match last_by_key(existing_accounts, "account_id", a.get("account_id")) {
            None => true,
            Some(existing) => !equal(existing.get("balances"), a.get("balances")),
        })
        .map(|a| {
            into_obj(json!({
                "user": { "user_id": user_id },
                "snapshot": snapshot_of_now(a.get("account_id")),
                "account": a,
            }))
        })
        .collect()
}

/// Writes the accounts, and an account-balance snapshot dated now for each
/// one that is new or whose balances changed.
pub async fn upsert_accounts_with_snapshots(user: &MaskedUser, incoming_accounts: &[Obj], existing_accounts: &[Obj]) {
    let snapshots = account_snapshots(&user.user_id, incoming_accounts, existing_accounts);
    upsert_accounts(user, incoming_accounts, None).await;
    upsert_snapshots(&snapshots).await;
}

/// The holding snapshots of a sync, and the stored holdings it removes: a
/// snapshot dated now for each incoming holding that is new or changed, and,
/// for each stored holding of a synced account the sync no longer reports, a
/// `quantity = 0` terminator snapshot and its id among the removed.
fn holding_snapshots(user_id: &str, incoming_holdings: &[Obj], existing_holdings: &[Obj]) -> (Vec<Obj>, Vec<String>) {
    let account_ids: Vec<Option<&Json>> = incoming_holdings.iter().map(|h| h.get("account_id")).collect();

    let mut snapshots: Vec<Obj> = incoming_holdings
        .iter()
        .filter(|h| match last_by_key(existing_holdings, "holding_id", h.get("holding_id")) {
            None => true,
            Some(existing) => !is_equal(&Json::Object(existing.clone()), &Json::Object((*h).clone()), false),
        })
        .map(|h| {
            into_obj(json!({
                "user": { "user_id": user_id },
                "snapshot": snapshot_of_now(h.get("holding_id")),
                "holding": h,
            }))
        })
        .collect();

    let mut removed_holding_ids: Vec<String> = Vec::new();

    for h in existing_holdings.iter().filter(|h| {
        account_ids.iter().any(|id| same_key(*id, h.get("account_id")))
            && last_by_key(incoming_holdings, "holding_id", h.get("holding_id")).is_none()
    }) {
        removed_holding_ids.push(interpolate(h.get("holding_id")));
        let mut holding = h.clone();
        holding.insert("quantity".into(), json!(0));
        holding.insert("institution_value".into(), json!(0));
        snapshots.push(into_obj(json!({
            "user": { "user_id": user_id },
            "snapshot": snapshot_of_now(h.get("holding_id")),
            "holding": holding,
        })));
    }

    (snapshots, removed_holding_ids)
}

/// Writes the holdings, a holding snapshot dated now for each one that is new
/// or changed, and, for each stored holding of a synced account the sync no
/// longer reports, a `quantity = 0` terminator snapshot before the holding
/// itself is deleted.
pub async fn upsert_and_delete_holdings_with_snapshots(
    user: &MaskedUser,
    incoming_holdings: &[Obj],
    existing_holdings: &[Obj],
) -> anyhow::Result<()> {
    let (snapshots, removed_holding_ids) = holding_snapshots(&user.user_id, incoming_holdings, existing_holdings);
    upsert_holdings(user, incoming_holdings).await;
    upsert_snapshots(&snapshots).await;
    delete_holdings(user, &removed_holding_ids).await?;
    Ok(())
}

/// Which date a security's price snapshot is filed under.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PriceSnapshotDate {
    /// The trading day the provider says its close is for. Plaid's
    /// `close_price_as_of` is often the previous trading day.
    ClosePriceAsOf,
    /// The moment of the sync, for providers whose `close_price_as_of` isn't
    /// a price date (SimpleFIN fills it with the holding's creation time).
    #[default]
    SyncTime,
}

// Crypto always uses `SyncTime`: it trades around the clock, so its price is
// current as of the sync, whatever date the provider attaches to it.

static PRICE_DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}").unwrap());

/// What `upsert_securities_with_snapshots` writes: the securities, their price
/// snapshots, and the ids of the securities.
#[derive(Debug, Default)]
struct SecurityWrites {
    securities: Vec<Obj>,
    snapshots: Vec<Obj>,
    ids: HashSet<String>,
}

fn security_writes(securities: &[Obj], price_date: PriceSnapshotDate) -> SecurityWrites {
    let mut writes = SecurityWrites::default();

    for s in securities {
        if !js::truthy_opt(s.get("ticker_symbol")) {
            continue;
        }
        let close_price_as_of = s.get("close_price_as_of");
        if !js::truthy_opt(s.get("close_price")) || !js::truthy_opt(close_price_as_of) {
            continue;
        }

        let new_security = s.clone();
        let security_id = interpolate(new_security.get("security_id"));
        let snapshot = if price_date == PriceSnapshotDate::ClosePriceAsOf && s.get("type").and_then(Json::as_str) != Some("cryptocurrency")
        {
            // Built from the date string itself, in the daily refresh's
            // format, so no server time zone can move the row to a
            // neighbouring day.
            let as_of = interpolate(close_price_as_of);
            let Some(day) = PRICE_DATE.find(&as_of).map(|day| day.as_str().to_string()) else { continue };
            json!({ "snapshot_id": format!("{security_id}-{}", day.replace('-', "")), "date": format!("{day}T12:00:00.000Z") })
        } else {
            snapshot_of_now(new_security.get("security_id"))
        };
        writes.snapshots.push(into_obj(json!({ "snapshot": snapshot, "security": new_security })));

        writes.securities.push(new_security);
        writes.ids.insert(security_id);
    }
    writes
}

/// Upserts incoming securities and writes a price snapshot for each, dated
/// per `price_date`. `security_id` is treated as identity: two rows can share
/// a ticker (user-minted and provider-synced), and the holdings view folds
/// them by ticker on read. Returns the ids of the securities written, so
/// callers can drop holdings whose security was filtered out here (no ticker
/// or no close price). An id that is not a string is held as its `String()`.
pub async fn upsert_securities_with_snapshots(securities: &[Obj], price_date: PriceSnapshotDate) -> HashSet<String> {
    let writes = security_writes(securities, price_date);
    upsert_securities(&writes.securities).await;
    upsert_snapshots(&writes.snapshots).await;
    writes.ids
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(value: Json) -> Obj {
        value.as_object().cloned().unwrap()
    }

    fn today() -> String {
        get_squashed_date_string(JsDate::now())
    }

    // `create-snapshots.test.ts`, "upsertSecuritiesWithSnapshots — identity-not-ticker semantics".

    fn security(overrides: Json) -> Obj {
        let mut security = obj(json!({
            "security_id": "sec-a",
            "name": "Test Security",
            "ticker_symbol": "TICK",
            "type": "equity",
            "close_price": 100,
            "close_price_as_of": "2026-07-06",
            "iso_currency_code": "USD",
            "isin": null,
            "cusip": null,
        }));
        security.extend(obj(overrides));
        security
    }

    fn ids(writes: &SecurityWrites) -> Vec<&str> {
        let mut ids: Vec<&str> = writes.ids.iter().map(String::as_str).collect();
        ids.sort();
        ids
    }

    fn snapshot_ids(writes: &SecurityWrites) -> Vec<String> {
        writes.snapshots.iter().map(|s| s["snapshot"]["snapshot_id"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn two_securities_with_the_same_ticker_but_different_ids_both_survive() {
        let writes = security_writes(
            &[
                security(json!({ "security_id": "manual-voo", "ticker_symbol": "VOO" })),
                security(json!({ "security_id": "plaid-voo", "ticker_symbol": "VOO" })),
            ],
            PriceSnapshotDate::SyncTime,
        );
        assert_eq!(ids(&writes), ["manual-voo", "plaid-voo"]);
        // Each is written under its own id: nothing is looked up by ticker and rewritten.
        let written: Vec<&Json> = writes.securities.iter().map(|s| &s["security_id"]).collect();
        assert_eq!(written, [&json!("manual-voo"), &json!("plaid-voo")]);
    }

    #[test]
    fn skips_securities_without_a_ticker_symbol() {
        let writes = security_writes(
            &[
                security(json!({ "security_id": "no-ticker", "ticker_symbol": null })),
                security(json!({ "security_id": "with-ticker", "ticker_symbol": "AAPL" })),
            ],
            PriceSnapshotDate::SyncTime,
        );
        assert_eq!(ids(&writes), ["with-ticker"]);
    }

    #[test]
    fn skips_securities_without_a_close_price_or_close_price_as_of() {
        let writes = security_writes(
            &[
                security(json!({ "security_id": "no-price", "close_price": null })),
                security(json!({ "security_id": "zero-price", "close_price": 0 })),
                security(json!({ "security_id": "no-date", "close_price_as_of": null })),
                security(json!({ "security_id": "ok" })),
            ],
            PriceSnapshotDate::SyncTime,
        );
        assert_eq!(ids(&writes), ["ok"]);
        assert_eq!(writes.securities.len(), 1);
        assert_eq!(writes.snapshots.len(), 1);
    }

    #[test]
    fn writes_nothing_when_there_is_nothing_to_upsert() {
        let writes = security_writes(&[], PriceSnapshotDate::SyncTime);
        assert!(writes.ids.is_empty() && writes.securities.is_empty() && writes.snapshots.is_empty());
    }

    #[test]
    fn the_security_is_written_whole_and_the_snapshot_carries_it() {
        let input = security(json!({}));
        let writes = security_writes(std::slice::from_ref(&input), PriceSnapshotDate::ClosePriceAsOf);
        assert_eq!(writes.securities, [input.clone()]);
        assert_eq!(
            Json::Object(writes.snapshots[0].clone()),
            json!({ "snapshot": { "snapshot_id": "sec-a-20260706", "date": "2026-07-06T12:00:00.000Z" }, "security": input })
        );
    }

    // "upsertSecuritiesWithSnapshots — price snapshot date".

    #[test]
    fn close_price_as_of_keys_the_snapshot_on_the_trading_day_the_close_is_for() {
        let writes = security_writes(&[security(json!({ "close_price_as_of": "2026-07-06" }))], PriceSnapshotDate::ClosePriceAsOf);
        assert_eq!(writes.snapshots[0]["snapshot"], json!({ "snapshot_id": "sec-a-20260706", "date": "2026-07-06T12:00:00.000Z" }));
    }

    #[test]
    fn close_price_as_of_reads_the_calendar_date_as_written_whatever_time_and_offset_follow_it() {
        let writes = security_writes(
            &[security(json!({ "security_id": "sec-b", "close_price_as_of": "2026-07-02T23:00:00-07:00" }))],
            PriceSnapshotDate::ClosePriceAsOf,
        );
        assert_eq!(snapshot_ids(&writes), ["sec-b-20260702"]);
    }

    #[test]
    fn close_price_as_of_skips_a_security_whose_close_price_as_of_is_not_a_date() {
        let writes = security_writes(
            &[
                security(json!({ "security_id": "bad-date", "close_price_as_of": "yesterday" })),
                security(json!({ "security_id": "digits", "close_price_as_of": "２０２６-07-06" })),
                security(json!({ "security_id": "ok" })),
            ],
            PriceSnapshotDate::ClosePriceAsOf,
        );
        assert_eq!(ids(&writes), ["ok"]);
    }

    #[test]
    fn crypto_stays_on_the_sync_date() {
        let writes = security_writes(
            &[security(json!({ "security_id": "btc", "type": "cryptocurrency", "close_price_as_of": "2026-06-01" }))],
            PriceSnapshotDate::ClosePriceAsOf,
        );
        assert_eq!(snapshot_ids(&writes), [format!("btc-{}", today())]);
    }

    #[test]
    fn sync_time_the_default_files_the_price_under_the_sync_date() {
        let writes =
            security_writes(&[security(json!({ "security_id": "sfin", "close_price_as_of": "2024-01-01" }))], PriceSnapshotDate::default());
        assert_eq!(snapshot_ids(&writes), [format!("sfin-{}", today())]);
        let date = writes.snapshots[0]["snapshot"]["date"].as_str().unwrap();
        assert!((JsDate::parse(date).get_time() - JsDate::now_ms()).abs() < 60_000.0);
    }

    // `upsertAccountsWithSnapshots`.

    fn account(account_id: &str, current: f64) -> Obj {
        obj(json!({ "account_id": account_id, "name": "Checking", "balances": { "current": current, "available": null } }))
    }

    #[test]
    fn an_account_gets_a_snapshot_when_it_is_new_or_its_balances_changed() {
        let incoming = [account("new", 1.0), account("same", 2.0), account("changed", 3.0)];
        let mut renamed = account("same", 2.0);
        renamed.insert("name".into(), json!("Renamed"));
        let existing = [renamed, account("changed", 4.0), account("gone", 5.0)];
        let snapshots = account_snapshots("user-1", &incoming, &existing);
        assert_eq!(snapshots.len(), 2);
        assert_eq!(
            Json::Object(snapshots[0].clone()),
            json!({
                "user": { "user_id": "user-1" },
                "snapshot": { "snapshot_id": format!("new-{}", today()), "date": snapshots[0]["snapshot"]["date"] },
                "account": incoming[0],
            })
        );
        assert_eq!(snapshots[1]["account"]["account_id"], json!("changed"));
    }

    #[test]
    fn the_last_stored_account_with_an_id_is_the_one_compared() {
        let snapshots = account_snapshots("u", &[account("a", 1.0)], &[account("a", 1.0), account("a", 9.0)]);
        assert_eq!(snapshots.len(), 1);
        let snapshots = account_snapshots("u", &[account("a", 1.0)], &[account("a", 9.0), account("a", 1.0)]);
        assert!(snapshots.is_empty());
    }

    #[test]
    fn balances_absent_on_both_sides_are_equal_and_on_one_side_are_not() {
        let bare = obj(json!({ "account_id": "a" }));
        assert!(account_snapshots("u", std::slice::from_ref(&bare), std::slice::from_ref(&bare)).is_empty());
        assert_eq!(account_snapshots("u", &[account("a", 1.0)], &[bare]).len(), 1);
    }

    // `upsertAndDeleteHoldingsWithSnapshots`.

    fn holding(holding_id: &str, account_id: &str, quantity: f64) -> Obj {
        obj(json!({
            "holding_id": holding_id,
            "account_id": account_id,
            "security_id": "sec-1",
            "quantity": quantity,
            "institution_value": quantity * 10.0,
        }))
    }

    #[test]
    fn a_holding_gets_a_snapshot_when_new_or_changed_and_a_terminator_when_its_account_no_longer_reports_it() {
        let incoming = [holding("h-new", "acc-1", 1.0), holding("h-same", "acc-1", 2.0), holding("h-changed", "acc-1", 3.0)];
        let existing = [
            holding("h-same", "acc-1", 2.0),
            holding("h-changed", "acc-1", 4.0),
            holding("h-sold", "acc-1", 5.0),
            // Another account the sync did not report on is left alone.
            holding("h-elsewhere", "acc-2", 6.0),
        ];
        let (snapshots, removed) = holding_snapshots("user-1", &incoming, &existing);
        let snapshot_ids: Vec<&str> = snapshots.iter().map(|s| s["snapshot"]["snapshot_id"].as_str().unwrap()).collect();
        let day = today();
        assert_eq!(snapshot_ids, [format!("h-new-{day}"), format!("h-changed-{day}"), format!("h-sold-{day}")]);
        assert_eq!(snapshots[0]["holding"], Json::Object(incoming[0].clone()));
        assert_eq!(snapshots[0]["user"], json!({ "user_id": "user-1" }));
        assert_eq!(
            snapshots[2]["holding"],
            json!({ "holding_id": "h-sold", "account_id": "acc-1", "security_id": "sec-1", "quantity": 0, "institution_value": 0 })
        );
        assert_eq!(removed, ["h-sold"]);
    }

    #[test]
    fn nothing_is_removed_when_nothing_comes_in() {
        let (snapshots, removed) = holding_snapshots("u", &[], &[holding("h-1", "acc-1", 1.0)]);
        assert!(snapshots.is_empty() && removed.is_empty());
    }

    #[test]
    fn keys_compare_the_way_a_map_does() {
        assert!(same_key(None, None));
        assert!(same_key(Some(&json!(1)), Some(&json!(1.0))));
        assert!(!same_key(Some(&json!(1)), Some(&json!("1"))));
        assert!(!same_key(Some(&json!({})), Some(&json!({}))));
        assert!(!same_key(None, Some(&Json::Null)));
    }
}
