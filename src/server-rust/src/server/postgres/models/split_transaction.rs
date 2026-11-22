//! `src/server/lib/postgres/models/split_transaction.ts`.

use super::base::{Check, IndexDefinition, Row, Table};
use super::js_object::{nullish_or, prop, truthy_only, Literal};
use crate::js::{Json, Obj};
use crate::server::postgres::database::QueryData;

pub static TABLE: Table = Table {
    name: "split_transactions",
    primary_key: "split_transaction_id",
    schema: &[
        ("split_transaction_id", "UUID PRIMARY KEY DEFAULT gen_random_uuid()"),
        ("user_id", "UUID REFERENCES users(user_id) ON DELETE RESTRICT NOT NULL"),
        ("transaction_id", "VARCHAR(255) NOT NULL"),
        ("account_id", "VARCHAR(255) NOT NULL"),
        ("amount", "DECIMAL(15, 2) DEFAULT 0"),
        ("date", "DATE NOT NULL"),
        ("custom_name", "TEXT DEFAULT ''"),
        ("label_budget_id", "UUID"),
        ("label_category_id", "UUID"),
        ("label_memo", "TEXT"),
        // Mirrors the same column on `transactions`. Required for the two-pass
        // auto-suggest engine to write per-split suggestions.
        ("label_category_confidence", "FLOAT"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("is_deleted", "BOOLEAN DEFAULT FALSE"),
    ],
    constraints: &[],
    indexes: &[
        IndexDefinition::column("transaction_id"),
        IndexDefinition::column("account_id"),
        // Delta-by-cursor warm sync filters `WHERE user_id = ? AND updated >= ?` on
        // every app load; the composite keeps the read O(rows-changed).
        // Also the only `user_id` index this table needs: a `user_id`-only lookup is a
        // leftmost-prefix scan of this composite.
        IndexDefinition::columns(&["user_id", "updated"]),
    ],
    model: "SplitTransactionModel",
    checks: &[
        ("split_transaction_id", Check::String),
        ("user_id", Check::String),
        ("transaction_id", Check::String),
        ("account_id", Check::String),
        ("amount", Check::NullableNumber),
        ("date", Check::NullableString),
        ("custom_name", Check::NullableString),
        ("label_budget_id", Check::NullableString),
        ("label_category_id", Check::NullableString),
        ("label_memo", Check::NullableString),
        ("label_category_confidence", Check::NullableNumber),
        ("updated", Check::NullableString),
        ("is_deleted", Check::NullableBoolean),
    ],
    supports_soft_delete: true,
};

/// `splitTransactionColumns`.
pub fn columns() -> Vec<&'static str> {
    TABLE.columns()
}

/// `toJSON()`: a `JSONSplitTransaction`, without `date` when the row has none.
pub fn to_json(row: &Row) -> Json {
    Literal::new()
        .opt("split_transaction_id", row.get("split_transaction_id"))
        .opt("transaction_id", row.get("transaction_id"))
        .opt("account_id", row.get("account_id"))
        .opt("amount", row.get("amount"))
        .opt("date", truthy_only(row.get("date")))
        .opt("custom_name", row.get("custom_name"))
        .set(
            "label",
            Literal::new()
                .opt("budget_id", row.get("label_budget_id"))
                .opt("category_id", row.get("label_category_id"))
                .opt("memo", row.get("label_memo"))
                .opt("category_confidence", row.get("label_category_confidence")),
        )
        .set("is_deleted", nullish_or(row.get("is_deleted"), false))
        .into()
}

/// `fromJSON()`: the columns a (partial) `JSONSplitTransaction` sets.
pub fn from_json(tx: &Obj, user_id: &str) -> QueryData {
    let label = truthy_only(tx.get("label"));
    Literal::new()
        .set("user_id", user_id)
        .opt("split_transaction_id", tx.get("split_transaction_id"))
        .opt("transaction_id", tx.get("transaction_id"))
        .opt("account_id", tx.get("account_id"))
        .opt("amount", tx.get("amount"))
        .opt("date", tx.get("date"))
        .opt("custom_name", tx.get("custom_name"))
        .opt("label_budget_id", prop(label, "budget_id"))
        .opt("label_category_id", prop(label, "category_id"))
        .opt("label_memo", prop(label, "memo"))
        .opt("label_category_confidence", prop(label, "category_confidence"))
        .into_obj()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::js_object::testing::{assert_json, assert_row, obj};
    use super::*;

    fn row() -> Json {
        json!({
            "split_transaction_id": "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
            "user_id": "0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10",
            "transaction_id": "tx-1",
            "account_id": "acc-checking",
            "amount": 12.5,
            "date": "2026-05-15",
            "custom_name": "Half of dinner",
            "label_budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
            "label_category_id": "c2a4b1de-7c64-4b6e-9e0a-6a1d2c3b4e5f",
            "label_memo": null,
            "label_category_confidence": 1,
            "updated": "2026-05-16T00:00:00.000Z",
            "is_deleted": false,
        })
    }

    #[test]
    fn to_json_nests_the_label() {
        let row = TABLE.validate(obj(row())).unwrap();
        assert_json(
            &to_json(&row),
            json!({
                "split_transaction_id": "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
                "transaction_id": "tx-1",
                "account_id": "acc-checking",
                "amount": 12.5,
                "date": "2026-05-15",
                "custom_name": "Half of dinner",
                "label": {
                    "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
                    "category_id": "c2a4b1de-7c64-4b6e-9e0a-6a1d2c3b4e5f",
                    "memo": null,
                    "category_confidence": 1,
                },
                "is_deleted": false,
            }),
        );
    }

    #[test]
    fn to_json_omits_a_missing_date_and_defaults_a_null_tombstone_flag() {
        let mut row = obj(row());
        row.insert("date".into(), Json::Null);
        row.insert("is_deleted".into(), Json::Null);
        row.insert("amount".into(), Json::Null);
        row.insert("label_category_confidence".into(), Json::Null);
        assert_json(
            &to_json(&row),
            json!({
                "split_transaction_id": "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
                "transaction_id": "tx-1",
                "account_id": "acc-checking",
                "amount": null,
                "custom_name": "Half of dinner",
                "label": {
                    "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
                    "category_id": "c2a4b1de-7c64-4b6e-9e0a-6a1d2c3b4e5f",
                    "memo": null,
                    "category_confidence": null,
                },
                "is_deleted": false,
            }),
        );
    }

    #[test]
    fn from_json_flattens_the_label() {
        let tx = obj(json!({
            "split_transaction_id": "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
            "transaction_id": "tx-1",
            "account_id": "acc-checking",
            "amount": 12.5,
            "date": "2026-05-15",
            "custom_name": "",
            "label": { "budget_id": null, "category_id": "c2a4b1de-7c64-4b6e-9e0a-6a1d2c3b4e5f", "memo": "split", "category_confidence": 0 },
            "is_deleted": false,
        }));
        assert_row(
            &from_json(&tx, "user-1"),
            json!({
                "user_id": "user-1",
                "split_transaction_id": "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
                "transaction_id": "tx-1",
                "account_id": "acc-checking",
                "amount": 12.5,
                "date": "2026-05-15",
                "custom_name": "",
                "label_budget_id": null,
                "label_category_id": "c2a4b1de-7c64-4b6e-9e0a-6a1d2c3b4e5f",
                "label_memo": "split",
                "label_category_confidence": 0,
            }),
        );
    }

    #[test]
    fn from_json_sets_only_the_label_fields_that_are_given() {
        let relabel = obj(json!({ "split_transaction_id": "split-1", "label": { "category_id": null, "category_confidence": null } }));
        assert_row(
            &from_json(&relabel, "user-1"),
            json!({ "user_id": "user-1", "split_transaction_id": "split-1", "label_category_id": null, "label_category_confidence": null }),
        );
        assert_row(&from_json(&obj(json!({ "amount": 3, "label": null })), "user-1"), json!({ "user_id": "user-1", "amount": 3 }));
    }
}
