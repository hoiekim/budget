//! `src/server/lib/postgres/models/snapshot.ts`.

use super::base::{Check, IndexDefinition, Row, Table};
use super::js_object::{nullish_or, prop, Literal};
use crate::js::{Json, Obj};
use crate::server::postgres::database::QueryData;

/// `SnapshotType`: what a row of the one snapshots table is a snapshot of.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapshotType {
    AccountBalance,
    Security,
    Holding,
}

impl SnapshotType {
    /// The value of the `snapshot_type` column.
    pub fn as_str(self) -> &'static str {
        match self {
            SnapshotType::AccountBalance => "account_balance",
            SnapshotType::Security => "security",
            SnapshotType::Holding => "holding",
        }
    }

    pub fn parse(text: &str) -> Option<SnapshotType> {
        match text {
            "account_balance" => Some(SnapshotType::AccountBalance),
            "security" => Some(SnapshotType::Security),
            "holding" => Some(SnapshotType::Holding),
            _ => None,
        }
    }
}

pub static TABLE: Table = Table {
    name: "snapshots",
    primary_key: "snapshot_id",
    schema: &[
        ("snapshot_id", "VARCHAR(255) PRIMARY KEY"),
        ("user_id", "UUID"),
        ("snapshot_date", "TIMESTAMPTZ NOT NULL"),
        ("snapshot_type", "VARCHAR(50) NOT NULL"),
        ("account_id", "VARCHAR(255)"),
        ("balances_available", "DECIMAL(15, 2)"),
        ("balances_current", "DECIMAL(15, 2)"),
        ("balances_limit", "DECIMAL(15, 2)"),
        ("balances_iso_currency_code", "VARCHAR(10)"),
        ("security_id", "VARCHAR(255)"),
        ("close_price", "DECIMAL(15, 6)"),
        ("holding_account_id", "VARCHAR(255)"),
        ("holding_security_id", "VARCHAR(255)"),
        ("institution_price", "DECIMAL(15, 6)"),
        ("institution_value", "DECIMAL(15, 2)"),
        ("cost_basis", "DECIMAL(15, 2)"),
        ("quantity", "DECIMAL(15, 6)"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("is_deleted", "BOOLEAN DEFAULT FALSE"),
    ],
    constraints: &[],
    indexes: &[
        IndexDefinition::column("snapshot_type"),
        IndexDefinition::column("snapshot_date"),
        IndexDefinition::column("account_id"),
        IndexDefinition::column("security_id"),
        // Covers per-account holding-snapshot fetches in both `searchSnapshots`
        // (when caller narrows by account) and `getHoldingSnapshots`. Without
        // this, the WHERE-on-holding_account_id falls back to a user_id-index
        // scan + row filter: fine for low-cardinality users but slows down
        // as snapshot history grows.
        IndexDefinition::column("holding_account_id"),
        // `searchSnapshots` delta reads filter `WHERE user_id = ? AND updated >= ?`
        // on every app load; the composite keeps the read O(rows-changed).
        // Also the only `user_id` index this table needs: a `user_id`-only lookup is a
        // leftmost-prefix scan of this composite.
        IndexDefinition::columns(&["user_id", "updated"]),
        // A cold sync streams the user's whole table in primary-key batches.
        IndexDefinition::columns(&["user_id", "snapshot_id"]),
    ],
    model: "SnapshotModel",
    checks: &[
        ("snapshot_id", Check::String),
        ("user_id", Check::NullableString),
        ("snapshot_date", Check::String),
        ("snapshot_type", Check::String),
        ("account_id", Check::NullableString),
        ("balances_available", Check::NullableNumber),
        ("balances_current", Check::NullableNumber),
        ("balances_limit", Check::NullableNumber),
        ("balances_iso_currency_code", Check::NullableString),
        ("security_id", Check::NullableString),
        ("close_price", Check::NullableNumber),
        ("holding_account_id", Check::NullableString),
        ("holding_security_id", Check::NullableString),
        ("institution_price", Check::NullableNumber),
        ("institution_value", Check::NullableNumber),
        ("cost_basis", Check::NullableNumber),
        ("quantity", Check::NullableNumber),
        ("updated", Check::NullableString),
        ("is_deleted", Check::NullableBoolean),
    ],
    supports_soft_delete: true,
};

/// `snapshotColumns`.
pub fn columns() -> Vec<&'static str> {
    TABLE.columns()
}

/// `toJSON()`: the `JSONSnapshotData` of the row's `snapshot_type`.
///
/// A row of any other type is `undefined` in the TypeScript, whose `switch`
/// has no case for it. That is `null` here: what `undefined` serializes to in
/// the arrays every caller collects these into, and no snapshot is `null`.
pub fn to_json(row: &Row) -> Json {
    match row.get("snapshot_type").and_then(|kind| kind.as_str()).and_then(SnapshotType::parse) {
        Some(SnapshotType::AccountBalance) => to_account_snapshot(row),
        Some(SnapshotType::Security) => to_security_snapshot(row),
        Some(SnapshotType::Holding) => to_holding_snapshot(row),
        None => Json::Null,
    }
}

/// The `snapshot` every kind of `JSONSnapshotData` starts with.
fn snapshot_of(row: &Row) -> Literal {
    Literal::new()
        .opt("snapshot_id", row.get("snapshot_id"))
        .opt("date", row.get("snapshot_date"))
        .set("is_deleted", nullish_or(row.get("is_deleted"), false))
}

/// `toAccountSnapshot()`: a `JSONAccountSnapshot`, with as much of the
/// account as the row holds.
pub fn to_account_snapshot(row: &Row) -> Json {
    Literal::new()
        .set("snapshot", snapshot_of(row))
        .set("user", Literal::new().set("user_id", nullish_or(row.get("user_id"), "")))
        .set(
            "account",
            Literal::new().set("account_id", nullish_or(row.get("account_id"), "")).set(
                "balances",
                Literal::new()
                    .opt("current", row.get("balances_current"))
                    .opt("available", row.get("balances_available"))
                    .opt("limit", row.get("balances_limit"))
                    .opt("iso_currency_code", row.get("balances_iso_currency_code"))
                    .set("unofficial_currency_code", Json::Null),
            ),
        )
        .into()
}

/// `toSecuritySnapshot()`: a `JSONSecuritySnapshot`, with as much of the
/// security as the row holds.
pub fn to_security_snapshot(row: &Row) -> Json {
    Literal::new()
        .set("snapshot", snapshot_of(row))
        .set(
            "security",
            Literal::new().set("security_id", nullish_or(row.get("security_id"), "")).opt("close_price", row.get("close_price")),
        )
        .into()
}

/// `toHoldingSnapshot()`: a `JSONHoldingSnapshot`, with as much of the
/// holding as the row holds. An unknown cost basis stays `null`; the other
/// amounts read as zero.
pub fn to_holding_snapshot(row: &Row) -> Json {
    Literal::new()
        .set("snapshot", snapshot_of(row))
        .set("user", Literal::new().set("user_id", nullish_or(row.get("user_id"), "")))
        .set(
            "holding",
            Literal::new()
                .set("account_id", nullish_or(row.get("holding_account_id"), ""))
                .set("security_id", nullish_or(row.get("holding_security_id"), ""))
                .set("institution_price", nullish_or(row.get("institution_price"), 0))
                .set("institution_value", nullish_or(row.get("institution_value"), 0))
                .opt("cost_basis", row.get("cost_basis"))
                .set("quantity", nullish_or(row.get("quantity"), 0)),
        )
        .into()
}

/// `d[key]`, for the property reads that follow on it: an error where the
/// TypeScript throws reading a property of `undefined` or `null`.
fn part<'a>(d: &'a Obj, key: &str) -> anyhow::Result<&'a Json> {
    match d.get(key) {
        None | Some(Json::Null) => anyhow::bail!("The snapshot data has no {key}"),
        Some(part) => Ok(part),
    }
}

/// `fromAccountSnapshot()`: the row of a `JSONAccountSnapshot`. Balances the
/// account lacks are written as NULL. An error when `d` has no `snapshot` or
/// no `account`, which the TypeScript throws on.
pub fn from_account_snapshot(d: &Obj, user_id: &str) -> anyhow::Result<QueryData> {
    let snapshot = part(d, "snapshot")?;
    let account = part(d, "account")?;
    let balances = account.get("balances");
    Ok(Literal::new()
        .opt("snapshot_id", snapshot.get("snapshot_id"))
        .set("user_id", user_id)
        .opt("snapshot_date", snapshot.get("date"))
        .set("snapshot_type", SnapshotType::AccountBalance.as_str())
        .opt("account_id", account.get("account_id"))
        .set("balances_available", nullish_or(prop(balances, "available"), Json::Null))
        .set("balances_current", nullish_or(prop(balances, "current"), Json::Null))
        .set("balances_limit", nullish_or(prop(balances, "limit"), Json::Null))
        .set("balances_iso_currency_code", nullish_or(prop(balances, "iso_currency_code"), Json::Null))
        .into_obj())
}

/// `fromSecuritySnapshot()`: the row of a `JSONSecuritySnapshot`, which
/// belongs to no user. An error when `d` has no `snapshot` or no `security`,
/// which the TypeScript throws on.
pub fn from_security_snapshot(d: &Obj) -> anyhow::Result<QueryData> {
    let snapshot = part(d, "snapshot")?;
    let security = part(d, "security")?;
    Ok(Literal::new()
        .opt("snapshot_id", snapshot.get("snapshot_id"))
        .opt("snapshot_date", snapshot.get("date"))
        .set("snapshot_type", SnapshotType::Security.as_str())
        .opt("security_id", security.get("security_id"))
        .set("close_price", nullish_or(security.get("close_price"), Json::Null))
        .into_obj())
}

/// `fromHoldingSnapshot()`: the row of a `JSONHoldingSnapshot`. Amounts the
/// holding lacks are written as NULL. An error when `d` has no `snapshot` or
/// no `holding`, which the TypeScript throws on.
pub fn from_holding_snapshot(d: &Obj, user_id: &str) -> anyhow::Result<QueryData> {
    let snapshot = part(d, "snapshot")?;
    let holding = part(d, "holding")?;
    Ok(Literal::new()
        .opt("snapshot_id", snapshot.get("snapshot_id"))
        .set("user_id", user_id)
        .opt("snapshot_date", snapshot.get("date"))
        .set("snapshot_type", SnapshotType::Holding.as_str())
        .opt("holding_account_id", holding.get("account_id"))
        .opt("holding_security_id", holding.get("security_id"))
        .set("institution_price", nullish_or(holding.get("institution_price"), Json::Null))
        .set("institution_value", nullish_or(holding.get("institution_value"), Json::Null))
        .set("cost_basis", nullish_or(holding.get("cost_basis"), Json::Null))
        .set("quantity", nullish_or(holding.get("quantity"), Json::Null))
        .into_obj())
}

/// `isAccountSnapshot()`.
pub fn is_account_snapshot(d: &Obj) -> bool {
    d.contains_key("account")
}

/// `isSecuritySnapshot()`.
pub fn is_security_snapshot(d: &Obj) -> bool {
    d.contains_key("security")
}

/// `isHoldingSnapshot()`.
pub fn is_holding_snapshot(d: &Obj) -> bool {
    d.contains_key("holding")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::js_object::testing::{assert_json, assert_row, obj};
    use super::*;

    /// A row with every type-specific column empty, as each kind leaves the others'.
    fn row(snapshot_type: &str, columns: Json) -> Row {
        let mut row = obj(json!({
            "snapshot_id": "snap-1",
            "user_id": "u",
            "snapshot_date": "2026-01-02T00:00:00.000Z",
            "snapshot_type": snapshot_type,
            "account_id": null,
            "balances_available": null,
            "balances_current": null,
            "balances_limit": null,
            "balances_iso_currency_code": null,
            "security_id": null,
            "close_price": null,
            "holding_account_id": null,
            "holding_security_id": null,
            "institution_price": null,
            "institution_value": null,
            "cost_basis": null,
            "quantity": null,
            "updated": null,
            "is_deleted": false,
        }));
        row.extend(obj(columns));
        TABLE.validate(row).unwrap()
    }

    // The row of `snapshot.test.ts`.
    fn holding_row(cost_basis: Json) -> Row {
        row(
            "holding",
            json!({
                "snapshot_id": "holding-a-s-20260102",
                "holding_account_id": "a",
                "holding_security_id": "s",
                "institution_price": 1,
                "institution_value": 100,
                "cost_basis": cost_basis,
                "quantity": 100,
            }),
        )
    }

    // `snapshot.test.ts`, "SnapshotModel.toHoldingSnapshot".
    #[test]
    fn an_unknown_cost_basis_reaches_the_client_as_unknown_not_as_zero() {
        assert_eq!(to_holding_snapshot(&holding_row(Json::Null))["holding"].get("cost_basis"), Some(&Json::Null));
        assert_eq!(to_holding_snapshot(&holding_row(json!(250)))["holding"]["cost_basis"], json!(250));
    }

    #[test]
    fn to_json_of_a_holding_row_is_a_holding_snapshot() {
        assert_json(
            &to_json(&holding_row(json!(250))),
            json!({
                "snapshot": { "snapshot_id": "holding-a-s-20260102", "date": "2026-01-02T00:00:00.000Z", "is_deleted": false },
                "user": { "user_id": "u" },
                "holding": {
                    "account_id": "a",
                    "security_id": "s",
                    "institution_price": 1,
                    "institution_value": 100,
                    "cost_basis": 250,
                    "quantity": 100,
                },
            }),
        );
    }

    #[test]
    fn a_holding_snapshot_reads_missing_amounts_as_zero_but_not_the_cost_basis() {
        let empty = row("holding", json!({ "user_id": null, "is_deleted": null }));
        assert_json(
            &to_json(&empty),
            json!({
                "snapshot": { "snapshot_id": "snap-1", "date": "2026-01-02T00:00:00.000Z", "is_deleted": false },
                "user": { "user_id": "" },
                "holding": { "account_id": "", "security_id": "", "institution_price": 0, "institution_value": 0, "cost_basis": null, "quantity": 0 },
            }),
        );
    }

    #[test]
    fn to_json_of_an_account_balance_row_is_an_account_snapshot() {
        let account = row(
            "account_balance",
            json!({
                "account_id": "acc-checking",
                "balances_available": 100.5,
                "balances_current": 110,
                "balances_iso_currency_code": "USD",
                "is_deleted": true,
            }),
        );
        assert_json(
            &to_json(&account),
            json!({
                "snapshot": { "snapshot_id": "snap-1", "date": "2026-01-02T00:00:00.000Z", "is_deleted": true },
                "user": { "user_id": "u" },
                "account": {
                    "account_id": "acc-checking",
                    "balances": { "current": 110, "available": 100.5, "limit": null, "iso_currency_code": "USD", "unofficial_currency_code": null },
                },
            }),
        );
        assert!(is_account_snapshot(&obj(to_json(&account))));
        assert!(!is_holding_snapshot(&obj(to_json(&account))));
    }

    #[test]
    fn to_json_of_a_security_row_is_a_security_snapshot_with_no_user() {
        let security = row("security", json!({ "user_id": null, "security_id": "sec-voo", "close_price": 512.345678 }));
        let json = to_json(&security);
        assert_json(
            &json,
            json!({
                "snapshot": { "snapshot_id": "snap-1", "date": "2026-01-02T00:00:00.000Z", "is_deleted": false },
                "security": { "security_id": "sec-voo", "close_price": 512.345678 },
            }),
        );
        assert!(is_security_snapshot(&obj(json.clone())));
        assert!(!is_account_snapshot(&obj(json)));

        // A price the row lacks stays `null`; the id it lacks reads as empty.
        let empty = row("security", json!({ "user_id": null }));
        assert_json(&to_json(&empty)["security"], json!({ "security_id": "", "close_price": null }));
    }

    #[test]
    fn to_json_of_a_row_of_no_known_type_is_null() {
        assert_eq!(to_json(&row("budget", json!({}))), Json::Null);
        assert_eq!(SnapshotType::parse("account_balance").map(SnapshotType::as_str), Some("account_balance"));
        assert_eq!(SnapshotType::parse("Holding"), None);
    }

    #[test]
    fn from_account_snapshot_writes_null_for_the_balances_it_lacks() {
        let data = obj(json!({
            "snapshot": { "snapshot_id": "snap-1", "date": "2026-01-02T00:00:00.000Z" },
            "user": { "user_id": "someone-else" },
            "account": {
                "account_id": "acc-checking",
                "name": "Plaid Checking",
                "balances": { "available": 100.5, "current": 110, "limit": null, "unofficial_currency_code": null },
            },
        }));
        assert_row(
            &from_account_snapshot(&data, "user-1").unwrap(),
            json!({
                "snapshot_id": "snap-1",
                "user_id": "user-1",
                "snapshot_date": "2026-01-02T00:00:00.000Z",
                "snapshot_type": "account_balance",
                "account_id": "acc-checking",
                "balances_available": 100.5,
                "balances_current": 110,
                "balances_limit": null,
                "balances_iso_currency_code": null,
            }),
        );

        // No balances at all: `?.` reads every one as undefined, `??` writes null.
        let bare = obj(json!({ "snapshot": { "date": "2026-01-02" }, "account": {} }));
        assert_row(
            &from_account_snapshot(&bare, "user-1").unwrap(),
            json!({
                "user_id": "user-1",
                "snapshot_date": "2026-01-02",
                "snapshot_type": "account_balance",
                "balances_available": null,
                "balances_current": null,
                "balances_limit": null,
                "balances_iso_currency_code": null,
            }),
        );
    }

    #[test]
    fn from_security_snapshot_sets_no_user() {
        let data = obj(json!({
            "snapshot": { "snapshot_id": "snap-2", "date": "2026-01-02T00:00:00.000Z" },
            "security": { "security_id": "sec-voo", "close_price": 512.345678, "ticker_symbol": "VOO" },
        }));
        assert_row(
            &from_security_snapshot(&data).unwrap(),
            json!({
                "snapshot_id": "snap-2",
                "snapshot_date": "2026-01-02T00:00:00.000Z",
                "snapshot_type": "security",
                "security_id": "sec-voo",
                "close_price": 512.345678,
            }),
        );

        let unpriced = obj(json!({ "snapshot": { "snapshot_id": "snap-2" }, "security": { "security_id": "sec-voo" } }));
        assert_row(
            &from_security_snapshot(&unpriced).unwrap(),
            json!({ "snapshot_id": "snap-2", "snapshot_type": "security", "security_id": "sec-voo", "close_price": null }),
        );
    }

    #[test]
    fn from_holding_snapshot_writes_null_for_the_amounts_it_lacks() {
        let data = obj(json!({
            "snapshot": { "snapshot_id": "holding-a-s-20260102", "date": "2026-01-02T00:00:00.000Z" },
            "user": { "user_id": "someone-else" },
            "holding": { "account_id": "a", "security_id": "s", "institution_price": 1, "institution_value": 100, "quantity": 0 },
        }));
        assert_row(
            &from_holding_snapshot(&data, "user-1").unwrap(),
            json!({
                "snapshot_id": "holding-a-s-20260102",
                "user_id": "user-1",
                "snapshot_date": "2026-01-02T00:00:00.000Z",
                "snapshot_type": "holding",
                "holding_account_id": "a",
                "holding_security_id": "s",
                "institution_price": 1,
                "institution_value": 100,
                "cost_basis": null,
                "quantity": 0,
            }),
        );
    }

    #[test]
    fn a_snapshot_missing_the_part_its_kind_reads_is_refused() {
        let no_snapshot = obj(json!({ "account": {}, "security": {}, "holding": {} }));
        assert!(from_account_snapshot(&no_snapshot, "user-1").is_err());
        assert!(from_security_snapshot(&no_snapshot).is_err());
        assert!(from_holding_snapshot(&no_snapshot, "user-1").is_err());

        let only_snapshot = obj(json!({ "snapshot": {}, "account": null }));
        assert!(from_account_snapshot(&only_snapshot, "user-1").is_err());
        assert!(from_security_snapshot(&only_snapshot).is_err());
        assert!(from_holding_snapshot(&only_snapshot, "user-1").is_err());
    }
}
