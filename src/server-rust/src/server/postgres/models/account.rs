//! `src/server/lib/postgres/models/account.ts`.

use super::base::{Check, IndexDefinition, Row, Table};
use super::js_object::{entries, nullish_or, prop, rest, truthy_only, Literal};
use crate::js::{Json, Obj};
use crate::server::postgres::database::QueryData;

pub static TABLE: Table = Table {
    name: "accounts",
    primary_key: "account_id",
    schema: &[
        ("account_id", "VARCHAR(255) PRIMARY KEY"),
        ("user_id", "UUID REFERENCES users(user_id) ON DELETE RESTRICT NOT NULL"),
        ("item_id", "VARCHAR(255) NOT NULL"),
        ("institution_id", "VARCHAR(255) NOT NULL"),
        ("name", "VARCHAR(255)"),
        ("type", "VARCHAR(50)"),
        ("subtype", "VARCHAR(100)"),
        ("balances_available", "DECIMAL(15, 2)"),
        ("balances_current", "DECIMAL(15, 2)"),
        ("balances_limit", "DECIMAL(15, 2)"),
        ("balances_iso_currency_code", "VARCHAR(10)"),
        ("custom_name", "TEXT"),
        ("hide", "BOOLEAN DEFAULT FALSE"),
        ("archived", "BOOLEAN DEFAULT FALSE"),
        ("label_budget_id", "UUID"),
        ("graph_options_use_snapshots", "BOOLEAN DEFAULT TRUE"),
        ("graph_options_use_holding_snapshots", "BOOLEAN DEFAULT TRUE"),
        ("graph_options_use_transactions", "BOOLEAN DEFAULT TRUE"),
        ("plan_fund_mappings", "JSONB"),
        ("raw", "JSONB"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("is_deleted", "BOOLEAN DEFAULT FALSE"),
    ],
    constraints: &[],
    indexes: &[IndexDefinition::column("user_id"), IndexDefinition::column("item_id"), IndexDefinition::column("institution_id")],
    model: "AccountModel",
    checks: &[
        ("account_id", Check::String),
        ("user_id", Check::String),
        ("item_id", Check::String),
        ("institution_id", Check::String),
        ("name", Check::NullableString),
        ("type", Check::NullableString),
        ("subtype", Check::NullableString),
        ("balances_available", Check::NullableNumber),
        ("balances_current", Check::NullableNumber),
        ("balances_limit", Check::NullableNumber),
        ("balances_iso_currency_code", Check::NullableString),
        ("custom_name", Check::NullableString),
        ("hide", Check::NullableBoolean),
        ("archived", Check::NullableBoolean),
        ("label_budget_id", Check::NullableString),
        ("graph_options_use_snapshots", Check::NullableBoolean),
        ("graph_options_use_holding_snapshots", Check::NullableBoolean),
        ("graph_options_use_transactions", Check::NullableBoolean),
        // Keyed by the statement's fund name; an object rather than an array so the driver writes it as JSON.
        ("plan_fund_mappings", Check::OptionalNullableObject),
        ("raw", Check::NullableObject),
        ("updated", Check::NullableString),
        ("is_deleted", Check::NullableBoolean),
    ],
    supports_soft_delete: true,
};

/// `accountColumns`.
pub fn columns() -> Vec<&'static str> {
    TABLE.columns()
}

/// `toJSON()`: a `JSONAccount`. `plan_fund_mappings` is there only when the
/// column holds something, as the list of its entries.
///
/// Where an entry of the column is `null` the TypeScript throws reading its
/// `security_id`; here that entry keeps its `investment` alone. The
/// plan-statement import, the column's one writer, stores an object per fund.
pub fn to_json(row: &Row) -> Json {
    let mut json = Literal::new()
        .opt("account_id", row.get("account_id"))
        .opt("item_id", row.get("item_id"))
        .opt("institution_id", row.get("institution_id"))
        .opt("name", row.get("name"))
        .opt("type", row.get("type"))
        .opt("subtype", row.get("subtype"))
        .set("mask", Json::Null)
        .set("official_name", Json::Null)
        .set(
            "balances",
            Literal::new()
                .opt("available", row.get("balances_available"))
                .opt("current", row.get("balances_current"))
                .opt("limit", row.get("balances_limit"))
                .opt("iso_currency_code", row.get("balances_iso_currency_code"))
                .set("unofficial_currency_code", Json::Null),
        )
        .opt("custom_name", row.get("custom_name"))
        .opt("hide", row.get("hide"))
        .set("archived", nullish_or(row.get("archived"), false))
        .set("label", Literal::new().opt("budget_id", row.get("label_budget_id")))
        .set(
            "graphOptions",
            Literal::new()
                .opt("useSnapshots", row.get("graph_options_use_snapshots"))
                .set("useHoldingSnapshots", nullish_or(row.get("graph_options_use_holding_snapshots"), true))
                .opt("useTransactions", row.get("graph_options_use_transactions")),
        );
    if let Some(mappings) = truthy_only(row.get("plan_fund_mappings")) {
        let list: Vec<Json> = entries(mappings)
            .into_iter()
            .map(|(investment, mapping)| {
                Literal::new()
                    .set("investment", investment)
                    .opt("security_id", mapping.get("security_id"))
                    .opt("restated", mapping.get("restated"))
                    .into()
            })
            .collect();
        json = json.set("plan_fund_mappings", list);
    }
    json.into()
}

/// `fromJSON()`: the columns a (partial) `JSONAccount` sets. `raw` takes
/// what is left of it once the fields this app adds are taken out.
pub fn from_json(a: &Obj, user_id: &str) -> QueryData {
    let label = truthy_only(a.get("label"));
    let balances = truthy_only(a.get("balances"));
    let graph_options = truthy_only(a.get("graphOptions"));
    Literal::new()
        .set("user_id", user_id)
        .opt("account_id", a.get("account_id"))
        .opt("item_id", a.get("item_id"))
        .opt("institution_id", a.get("institution_id"))
        .opt("name", a.get("name"))
        .opt("type", a.get("type"))
        .opt("subtype", a.get("subtype"))
        .opt("custom_name", a.get("custom_name"))
        .opt("hide", a.get("hide"))
        .opt("archived", a.get("archived"))
        .opt("label_budget_id", prop(label, "budget_id"))
        .opt("balances_available", prop(balances, "available"))
        .opt("balances_current", prop(balances, "current"))
        .opt("balances_limit", prop(balances, "limit"))
        .opt("balances_iso_currency_code", prop(balances, "iso_currency_code"))
        .opt("graph_options_use_snapshots", prop(graph_options, "useSnapshots"))
        .opt("graph_options_use_holding_snapshots", prop(graph_options, "useHoldingSnapshots"))
        .opt("graph_options_use_transactions", prop(graph_options, "useTransactions"))
        .set(
            "raw",
            rest(
                a,
                &[
                    "custom_name",
                    "hide",
                    "archived",
                    "label",
                    "graphOptions",
                    // Written only by the plan-statement import, straight to the column.
                    "plan_fund_mappings",
                ],
            ),
        )
        .into_obj()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::js_object::testing::{assert_json, assert_row, obj};
    use super::*;

    fn row() -> Json {
        json!({
            "account_id": "acc-checking",
            "user_id": "0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10",
            "item_id": "item-1",
            "institution_id": "ins_3",
            "name": "Plaid Checking",
            "type": "depository",
            "subtype": "checking",
            "balances_available": 100.5,
            "balances_current": 110,
            "balances_limit": null,
            "balances_iso_currency_code": "USD",
            "custom_name": "Everyday",
            "hide": false,
            "archived": false,
            "label_budget_id": null,
            "graph_options_use_snapshots": true,
            "graph_options_use_holding_snapshots": true,
            "graph_options_use_transactions": false,
            "plan_fund_mappings": null,
            "raw": { "account_id": "acc-checking", "mask": "0000" },
            "updated": "2026-06-01T00:00:00.000Z",
            "is_deleted": false,
        })
    }

    #[test]
    fn a_row_passes_its_checks() {
        let validated = TABLE.validate(obj(row())).unwrap();
        assert_eq!(validated.len(), TABLE.checks.len());

        // `plan_fund_mappings` alone may be missing: rows read before the column existed.
        let mut without_mappings = obj(row());
        without_mappings.shift_remove("plan_fund_mappings");
        assert!(TABLE.validate(without_mappings).is_ok());

        let mut without_raw = obj(row());
        without_raw.shift_remove("raw");
        let error = TABLE.validate(without_raw).unwrap_err().to_string();
        assert_eq!(error, "AccountModel validation failed:\nraw: undefined (undefined)");
    }

    #[test]
    fn to_json_nests_the_flat_columns() {
        assert_json(
            &to_json(&obj(row())),
            json!({
                "account_id": "acc-checking",
                "item_id": "item-1",
                "institution_id": "ins_3",
                "name": "Plaid Checking",
                "type": "depository",
                "subtype": "checking",
                "mask": null,
                "official_name": null,
                "balances": {
                    "available": 100.5,
                    "current": 110,
                    "limit": null,
                    "iso_currency_code": "USD",
                    "unofficial_currency_code": null,
                },
                "custom_name": "Everyday",
                "hide": false,
                "archived": false,
                "label": { "budget_id": null },
                "graphOptions": { "useSnapshots": true, "useHoldingSnapshots": true, "useTransactions": false },
            }),
        );
    }

    #[test]
    fn to_json_defaults_only_the_two_nullish_coalesced_flags() {
        let mut row = obj(row());
        row.insert("archived".into(), Json::Null);
        row.insert("hide".into(), Json::Null);
        row.insert("graph_options_use_snapshots".into(), Json::Null);
        row.insert("graph_options_use_holding_snapshots".into(), Json::Null);
        row.insert("graph_options_use_transactions".into(), Json::Null);
        let json = to_json(&row);
        assert_eq!(json["archived"], json!(false));
        assert_eq!(json["hide"], Json::Null);
        assert_json(&json["graphOptions"], json!({ "useSnapshots": null, "useHoldingSnapshots": true, "useTransactions": null }));
    }

    #[test]
    fn to_json_lists_plan_fund_mappings_only_when_the_column_holds_them() {
        let mut row = obj(row());
        assert!(to_json(&row).get("plan_fund_mappings").is_none());
        row.shift_remove("plan_fund_mappings");
        assert!(to_json(&row).get("plan_fund_mappings").is_none());

        row.insert(
            "plan_fund_mappings".into(),
            json!({
                "Target Date 2050 Trust": { "security_id": "sec-vfifx", "restated": true },
                "Stable Value": { "security_id": "sec-cash", "restated": false },
                "Unmapped": {},
            }),
        );
        assert_json(
            &to_json(&row)["plan_fund_mappings"],
            json!([
                { "investment": "Target Date 2050 Trust", "security_id": "sec-vfifx", "restated": true },
                { "investment": "Stable Value", "security_id": "sec-cash", "restated": false },
                { "investment": "Unmapped" },
            ]),
        );

        // An empty object is truthy, so the key is there with nothing in it.
        row.insert("plan_fund_mappings".into(), json!({}));
        assert_json(&to_json(&row)["plan_fund_mappings"], json!([]));
    }

    #[test]
    fn from_json_flattens_and_keeps_provider_data_as_raw() {
        let account = obj(json!({
            "account_id": "acc-checking",
            "item_id": "item-1",
            "institution_id": "ins_3",
            "name": "Plaid Checking",
            "type": "depository",
            "subtype": "checking",
            "mask": "0000",
            "official_name": null,
            "balances": { "available": 100.5, "current": 110, "limit": null, "iso_currency_code": "USD", "unofficial_currency_code": null },
            "custom_name": "Everyday",
            "hide": false,
            "archived": true,
            "label": { "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77" },
            "graphOptions": { "useSnapshots": true, "useHoldingSnapshots": false, "useTransactions": true },
            "plan_fund_mappings": [{ "investment": "Stable Value", "security_id": "sec-cash", "restated": false }],
        }));
        assert_row(
            &from_json(&account, "user-1"),
            json!({
                "user_id": "user-1",
                "account_id": "acc-checking",
                "item_id": "item-1",
                "institution_id": "ins_3",
                "name": "Plaid Checking",
                "type": "depository",
                "subtype": "checking",
                "custom_name": "Everyday",
                "hide": false,
                "archived": true,
                "label_budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
                "balances_available": 100.5,
                "balances_current": 110,
                "balances_limit": null,
                "balances_iso_currency_code": "USD",
                "graph_options_use_snapshots": true,
                "graph_options_use_holding_snapshots": false,
                "graph_options_use_transactions": true,
                "raw": {
                    "account_id": "acc-checking",
                    "item_id": "item-1",
                    "institution_id": "ins_3",
                    "name": "Plaid Checking",
                    "type": "depository",
                    "subtype": "checking",
                    "mask": "0000",
                    "official_name": null,
                    "balances": { "available": 100.5, "current": 110, "limit": null, "iso_currency_code": "USD", "unofficial_currency_code": null },
                },
            }),
        );
    }

    #[test]
    fn from_json_sets_null_where_given_and_nothing_where_absent() {
        let partial = obj(json!({ "account_id": "acc-1", "subtype": null, "label": { "budget_id": null }, "balances": {}, "graphOptions": null }));
        assert_row(
            &from_json(&partial, "user-1"),
            json!({ "user_id": "user-1", "account_id": "acc-1", "subtype": null, "label_budget_id": null, "raw": { "account_id": "acc-1", "subtype": null, "balances": {} } }),
        );

        // A label with no `budget_id` leaves the column alone.
        let unlabeled = obj(json!({ "account_id": "acc-1", "label": {} }));
        assert_row(&from_json(&unlabeled, "user-1"), json!({ "user_id": "user-1", "account_id": "acc-1", "raw": { "account_id": "acc-1" } }));
    }
}
