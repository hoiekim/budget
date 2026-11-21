//! `src/server/lib/postgres/models/holding.ts`.

use super::base::{Check, IndexDefinition, Row, Table};
use super::js_object::{interpolate, truthy_only, Literal};
use crate::js::{Json, Obj};
use crate::server::postgres::database::QueryData;

pub static TABLE: Table = Table {
    name: "holdings",
    primary_key: "holding_id",
    schema: &[
        ("holding_id", "VARCHAR(255) PRIMARY KEY"),
        ("user_id", "UUID REFERENCES users(user_id) ON DELETE RESTRICT NOT NULL"),
        ("account_id", "VARCHAR(255) NOT NULL"),
        ("security_id", "VARCHAR(255) NOT NULL"),
        ("institution_price", "DECIMAL(15, 6)"),
        ("institution_price_as_of", "DATE"),
        ("institution_value", "DECIMAL(15, 2)"),
        ("cost_basis", "DECIMAL(15, 2)"),
        ("quantity", "DECIMAL(15, 6)"),
        ("iso_currency_code", "VARCHAR(10)"),
        ("raw", "JSONB"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("is_deleted", "BOOLEAN DEFAULT FALSE"),
    ],
    constraints: &[],
    indexes: &[IndexDefinition::column("user_id"), IndexDefinition::column("account_id"), IndexDefinition::column("security_id")],
    model: "HoldingModel",
    checks: &[
        ("holding_id", Check::String),
        ("user_id", Check::String),
        ("account_id", Check::String),
        ("security_id", Check::String),
        ("institution_price", Check::NullableNumber),
        ("institution_price_as_of", Check::NullableString),
        ("institution_value", Check::NullableNumber),
        ("cost_basis", Check::NullableNumber),
        ("quantity", Check::NullableNumber),
        ("iso_currency_code", Check::NullableString),
        ("raw", Check::NullableObject),
        ("updated", Check::NullableString),
        ("is_deleted", Check::NullableBoolean),
    ],
    supports_soft_delete: true,
};

/// `holdingColumns`.
pub fn columns() -> Vec<&'static str> {
    TABLE.columns()
}

/// `toJSON()`: a `JSONHolding`.
pub fn to_json(row: &Row) -> Json {
    Literal::new()
        .opt("holding_id", row.get("holding_id"))
        .opt("account_id", row.get("account_id"))
        .opt("security_id", row.get("security_id"))
        .opt("institution_price", row.get("institution_price"))
        .opt("institution_price_as_of", row.get("institution_price_as_of"))
        .opt("institution_value", row.get("institution_value"))
        .opt("cost_basis", row.get("cost_basis"))
        .opt("quantity", row.get("quantity"))
        .opt("iso_currency_code", row.get("iso_currency_code"))
        .set("unofficial_currency_code", Json::Null)
        .into()
}

/// `fromJSON()`: the columns a (partial) `JSONHolding` sets. A holding with
/// no id of its own takes `<account_id>-<security_id>`, and `raw` keeps the
/// whole of what was given.
pub fn from_json(h: &Obj, user_id: &str) -> QueryData {
    let holding_id = match truthy_only(h.get("holding_id")) {
        Some(holding_id) => holding_id.clone(),
        None => Json::String(format!("{}-{}", interpolate(h.get("account_id")), interpolate(h.get("security_id")))),
    };
    Literal::new()
        .set("user_id", user_id)
        .set("holding_id", holding_id)
        .opt("account_id", h.get("account_id"))
        .opt("security_id", h.get("security_id"))
        .opt("institution_price", h.get("institution_price"))
        .opt("institution_price_as_of", h.get("institution_price_as_of"))
        .opt("institution_value", h.get("institution_value"))
        .opt("cost_basis", h.get("cost_basis"))
        .opt("quantity", h.get("quantity"))
        .opt("iso_currency_code", h.get("iso_currency_code"))
        .set("raw", h.clone())
        .into_obj()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::js_object::testing::{assert_json, assert_row, obj};
    use super::*;

    fn row() -> Json {
        json!({
            "holding_id": "acc-brokerage-sec-voo",
            "user_id": "0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10",
            "account_id": "acc-brokerage",
            "security_id": "sec-voo",
            "institution_price": 512.345678,
            "institution_price_as_of": "2026-06-01",
            "institution_value": 5123.46,
            "cost_basis": null,
            "quantity": 10,
            "iso_currency_code": "USD",
            "raw": { "holding_id": "acc-brokerage-sec-voo", "vested_quantity": 10 },
            "updated": "2026-06-01T00:00:00.000Z",
            "is_deleted": false,
        })
    }

    #[test]
    fn to_json_keeps_nulls_and_adds_the_currency_code_plaid_would() {
        let row = TABLE.validate(obj(row())).unwrap();
        assert_json(
            &to_json(&row),
            json!({
                "holding_id": "acc-brokerage-sec-voo",
                "account_id": "acc-brokerage",
                "security_id": "sec-voo",
                "institution_price": 512.345678,
                "institution_price_as_of": "2026-06-01",
                "institution_value": 5123.46,
                "cost_basis": null,
                "quantity": 10,
                "iso_currency_code": "USD",
                "unofficial_currency_code": null,
            }),
        );
    }

    #[test]
    fn from_json_derives_the_id_of_a_holding_without_one() {
        let holding = obj(json!({
            "account_id": "acc-brokerage",
            "security_id": "sec-voo",
            "institution_price": 512.345678,
            "institution_price_as_of": null,
            "institution_value": 5123.46,
            "cost_basis": 4000,
            "quantity": 10,
            "iso_currency_code": "USD",
            "unofficial_currency_code": null,
        }));
        assert_row(
            &from_json(&holding, "user-1"),
            json!({
                "user_id": "user-1",
                "holding_id": "acc-brokerage-sec-voo",
                "account_id": "acc-brokerage",
                "security_id": "sec-voo",
                "institution_price": 512.345678,
                "institution_price_as_of": null,
                "institution_value": 5123.46,
                "cost_basis": 4000,
                "quantity": 10,
                "iso_currency_code": "USD",
                "raw": {
                    "account_id": "acc-brokerage",
                    "security_id": "sec-voo",
                    "institution_price": 512.345678,
                    "institution_price_as_of": null,
                    "institution_value": 5123.46,
                    "cost_basis": 4000,
                    "quantity": 10,
                    "iso_currency_code": "USD",
                    "unofficial_currency_code": null,
                },
            }),
        );
    }

    #[test]
    fn from_json_keeps_an_id_that_is_given_and_replaces_an_empty_one() {
        let given = obj(json!({ "holding_id": "holding-9", "quantity": 2 }));
        assert_row(
            &from_json(&given, "user-1"),
            json!({ "user_id": "user-1", "holding_id": "holding-9", "quantity": 2, "raw": { "holding_id": "holding-9", "quantity": 2 } }),
        );

        // `||` falls through an empty id; the template spells out what is missing.
        let empty = obj(json!({ "holding_id": "", "account_id": "acc-1" }));
        assert_row(
            &from_json(&empty, "user-1"),
            json!({ "user_id": "user-1", "holding_id": "acc-1-undefined", "account_id": "acc-1", "raw": { "holding_id": "", "account_id": "acc-1" } }),
        );
        let null_security = obj(json!({ "account_id": "acc-1", "security_id": null }));
        assert_eq!(from_json(&null_security, "user-1")["holding_id"], json!("acc-1-null"));
    }
}
