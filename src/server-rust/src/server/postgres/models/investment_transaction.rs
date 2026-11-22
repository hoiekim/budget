//! `src/server/lib/postgres/models/investment_transaction.ts`.

use super::base::{Check, IndexDefinition, Row, Table};
use super::js_object::{nullish_or, prop, rest, truthy_only, Literal};
use crate::js::{Json, Obj};
use crate::server::postgres::database::QueryData;

pub static TABLE: Table = Table {
    name: "investment_transactions",
    primary_key: "investment_transaction_id",
    schema: &[
        ("investment_transaction_id", "VARCHAR(255) PRIMARY KEY"),
        ("user_id", "UUID REFERENCES users(user_id) ON DELETE RESTRICT NOT NULL"),
        ("account_id", "VARCHAR(255) NOT NULL"),
        ("security_id", "VARCHAR(255)"),
        ("date", "DATE NOT NULL"),
        ("name", "TEXT"),
        ("amount", "DECIMAL(15, 2)"),
        ("quantity", "DECIMAL(15, 6)"),
        ("price", "DECIMAL(15, 6)"),
        ("iso_currency_code", "VARCHAR(10)"),
        ("type", "TEXT"),
        ("subtype", "TEXT"),
        ("label_budget_id", "UUID"),
        ("label_category_id", "UUID"),
        ("label_memo", "TEXT"),
        ("raw", "JSONB"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("is_deleted", "BOOLEAN DEFAULT FALSE"),
        // See `transaction.rs`: the `plaid` / `manual` origin marker, with a safe
        // default so pre-existing rows and Plaid inserts don't need touching.
        ("source", "VARCHAR(20) NOT NULL DEFAULT 'plaid'"),
    ],
    constraints: &[],
    indexes: &[
        IndexDefinition::column("account_id"),
        IndexDefinition::column("date"),
        // Delta-by-cursor warm sync filters `WHERE user_id = ? AND updated >= ?` on
        // every app load; the composite keeps the read O(rows-changed).
        // Also the only `user_id` index this table needs: a `user_id`-only lookup is a
        // leftmost-prefix scan of this composite.
        IndexDefinition::columns(&["user_id", "updated"]),
        // A cold sync streams the user's whole table in primary-key batches.
        IndexDefinition::columns(&["user_id", "investment_transaction_id"]),
    ],
    model: "InvTxModel",
    checks: &[
        ("investment_transaction_id", Check::String),
        ("user_id", Check::String),
        ("account_id", Check::String),
        ("security_id", Check::NullableString),
        ("date", Check::String),
        ("name", Check::NullableString),
        ("amount", Check::NullableNumber),
        ("quantity", Check::NullableNumber),
        ("price", Check::NullableNumber),
        ("iso_currency_code", Check::NullableString),
        ("type", Check::NullableString),
        ("subtype", Check::NullableString),
        ("label_budget_id", Check::NullableString),
        ("label_category_id", Check::NullableString),
        ("label_memo", Check::NullableString),
        ("raw", Check::NullableObject),
        ("updated", Check::NullableString),
        ("is_deleted", Check::NullableBoolean),
        ("source", Check::NullableString),
    ],
    supports_soft_delete: true,
};

/// `investmentTransactionColumns`.
pub fn columns() -> Vec<&'static str> {
    TABLE.columns()
}

/// `toJSON()`: a `JSONInvestmentTransaction`.
pub fn to_json(row: &Row) -> Json {
    Literal::new()
        .opt("investment_transaction_id", row.get("investment_transaction_id"))
        .opt("account_id", row.get("account_id"))
        .opt("security_id", row.get("security_id"))
        .opt("date", row.get("date"))
        .opt("name", row.get("name"))
        .opt("quantity", row.get("quantity"))
        .opt("amount", row.get("amount"))
        .opt("price", row.get("price"))
        .opt("iso_currency_code", row.get("iso_currency_code"))
        .opt("type", row.get("type"))
        .opt("subtype", row.get("subtype"))
        .set("fees", Json::Null)
        .set("unofficial_currency_code", Json::Null)
        .set(
            "label",
            Literal::new()
                .opt("budget_id", row.get("label_budget_id"))
                .opt("category_id", row.get("label_category_id"))
                .opt("memo", row.get("label_memo")),
        )
        .set("is_deleted", nullish_or(row.get("is_deleted"), false))
        .set("source", nullish_or(row.get("source"), "plaid"))
        .into()
}

/// `fromJSON()`: the columns a (partial) `JSONInvestmentTransaction` sets.
/// `raw` takes what is left of it without the label and the origin marker.
pub fn from_json(tx: &Obj, user_id: &str) -> QueryData {
    let label = truthy_only(tx.get("label"));
    Literal::new()
        .set("user_id", user_id)
        .opt("investment_transaction_id", tx.get("investment_transaction_id"))
        .opt("account_id", tx.get("account_id"))
        .opt("security_id", tx.get("security_id"))
        .opt("date", tx.get("date"))
        .opt("name", tx.get("name"))
        .opt("amount", tx.get("amount"))
        .opt("quantity", tx.get("quantity"))
        .opt("price", tx.get("price"))
        .opt("iso_currency_code", tx.get("iso_currency_code"))
        .opt("type", tx.get("type"))
        .opt("subtype", tx.get("subtype"))
        .opt("label_budget_id", prop(label, "budget_id"))
        .opt("label_category_id", prop(label, "category_id"))
        .opt("label_memo", prop(label, "memo"))
        .opt("source", tx.get("source"))
        .set("raw", rest(tx, &["label", "source"]))
        .into_obj()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::js_object::testing::{assert_json, assert_row, obj};
    use super::*;

    fn row() -> Json {
        json!({
            "investment_transaction_id": "inv-tx-1",
            "user_id": "0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10",
            "account_id": "acc-brokerage",
            "security_id": "sec-voo",
            "date": "2026-05-15",
            "name": "BUY VANGUARD S&P 500 ETF",
            "amount": 5123.46,
            "quantity": 10,
            "price": 512.346,
            "iso_currency_code": "USD",
            "type": "buy",
            "subtype": "buy",
            "label_budget_id": null,
            "label_category_id": null,
            "label_memo": "monthly contribution",
            "raw": { "investment_transaction_id": "inv-tx-1", "fees": 0 },
            "updated": "2026-05-16T00:00:00.000Z",
            "is_deleted": false,
            "source": "plaid",
        })
    }

    #[test]
    fn to_json_puts_quantity_ahead_of_amount_and_nests_the_label() {
        let row = TABLE.validate(obj(row())).unwrap();
        assert_json(
            &to_json(&row),
            json!({
                "investment_transaction_id": "inv-tx-1",
                "account_id": "acc-brokerage",
                "security_id": "sec-voo",
                "date": "2026-05-15",
                "name": "BUY VANGUARD S&P 500 ETF",
                "quantity": 10,
                "amount": 5123.46,
                "price": 512.346,
                "iso_currency_code": "USD",
                "type": "buy",
                "subtype": "buy",
                "fees": null,
                "unofficial_currency_code": null,
                "label": { "budget_id": null, "category_id": null, "memo": "monthly contribution" },
                "is_deleted": false,
                "source": "plaid",
            }),
        );
    }

    #[test]
    fn to_json_defaults_a_null_tombstone_flag_and_origin() {
        let mut row = obj(row());
        row.insert("is_deleted".into(), Json::Null);
        row.insert("source".into(), Json::Null);
        row.insert("security_id".into(), Json::Null);
        let json = to_json(&row);
        assert_eq!(json["is_deleted"], json!(false));
        assert_eq!(json["source"], json!("plaid"));
        assert_eq!(json.get("security_id"), Some(&Json::Null));

        // `??` keeps every value that is not nullish, an empty origin included.
        row.insert("is_deleted".into(), json!(true));
        row.insert("source".into(), json!(""));
        let json = to_json(&row);
        assert_eq!(json["is_deleted"], json!(true));
        assert_eq!(json["source"], json!(""));
    }

    #[test]
    fn from_json_flattens_the_label_and_keeps_provider_data_as_raw() {
        let tx = obj(json!({
            "investment_transaction_id": "inv-tx-1",
            "account_id": "acc-brokerage",
            "security_id": "sec-voo",
            "date": "2026-05-15",
            "name": "BUY VANGUARD S&P 500 ETF",
            "quantity": 10,
            "amount": 5123.46,
            "price": 512.346,
            "fees": 0,
            "iso_currency_code": "USD",
            "unofficial_currency_code": null,
            "type": "buy",
            "subtype": "buy",
            "label": { "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77", "category_id": null },
            "source": "manual",
        }));
        assert_row(
            &from_json(&tx, "user-1"),
            json!({
                "user_id": "user-1",
                "investment_transaction_id": "inv-tx-1",
                "account_id": "acc-brokerage",
                "security_id": "sec-voo",
                "date": "2026-05-15",
                "name": "BUY VANGUARD S&P 500 ETF",
                "amount": 5123.46,
                "quantity": 10,
                "price": 512.346,
                "iso_currency_code": "USD",
                "type": "buy",
                "subtype": "buy",
                "label_budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
                "label_category_id": null,
                "source": "manual",
                "raw": {
                    "investment_transaction_id": "inv-tx-1",
                    "account_id": "acc-brokerage",
                    "security_id": "sec-voo",
                    "date": "2026-05-15",
                    "name": "BUY VANGUARD S&P 500 ETF",
                    "quantity": 10,
                    "amount": 5123.46,
                    "price": 512.346,
                    "fees": 0,
                    "iso_currency_code": "USD",
                    "unofficial_currency_code": null,
                    "type": "buy",
                    "subtype": "buy",
                },
            }),
        );
    }

    #[test]
    fn from_json_leaves_label_columns_alone_without_a_label() {
        let partial = obj(json!({ "investment_transaction_id": "inv-tx-1", "security_id": null, "label": null }));
        assert_row(
            &from_json(&partial, "user-1"),
            json!({
                "user_id": "user-1",
                "investment_transaction_id": "inv-tx-1",
                "security_id": null,
                "raw": { "investment_transaction_id": "inv-tx-1", "security_id": null },
            }),
        );
    }
}
