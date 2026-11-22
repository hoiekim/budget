//! `src/server/lib/postgres/models/recurring.ts`.

use super::base::{Check, IndexDefinition, Row, Table};
use super::js_object::Literal;
use crate::js::Json;

/// `isArray`: the one check here that `Check` has no variant for.
fn is_array(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::Array(_)))
}

pub static TABLE: Table = Table {
    name: "recurrings",
    primary_key: "recurring_id",
    schema: &[
        ("recurring_id", "UUID PRIMARY KEY"),
        ("user_id", "UUID REFERENCES users(user_id) ON DELETE RESTRICT NOT NULL"),
        ("merchant_key", "TEXT NOT NULL"),
        ("merchant_name", "TEXT NOT NULL"),
        ("cadence", "VARCHAR(20) NOT NULL"),
        ("is_income", "BOOLEAN NOT NULL"),
        ("status", "VARCHAR(20) NOT NULL"),
        ("transaction_ids", "TEXT[] NOT NULL DEFAULT '{}'"),
        ("label_budget_id", "UUID"),
        ("label_category_id", "UUID"),
        ("splits", "JSONB NOT NULL DEFAULT '[]'"),
        ("splits_since", "DATE"),
        ("created_at", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("is_deleted", "BOOLEAN DEFAULT FALSE"),
    ],
    constraints: &[
        // One recurring per (merchant, direction) per user. A merchant can be
        // both an income and an expense recurring (e.g. marketplace payouts
        // vs. purchases), but never two actives of the same direction: the
        // dismissed row is the denylist tombstone that `createRecurring`
        // un-dismisses via ON CONFLICT.
        "CONSTRAINT recurrings_user_merchant_direction_unique UNIQUE (user_id, merchant_key, is_income)",
    ],
    indexes: &[
        // Matches the delta-by-cursor read pattern the sync path uses:
        // `WHERE user_id = $1 AND updated >= $cursor`. Same shape every other
        // delta-fetched table carries (transactions, transaction_pairs,
        // snapshots). Without this, the planner does a user_id lookup then
        // scans + filters all of that user's recurrings.
        IndexDefinition::columns(&["user_id", "updated"]),
        // Detection lookups by merchant_key per user.
        IndexDefinition::columns(&["user_id", "merchant_key"]),
    ],
    model: "RecurringModel",
    checks: &[
        ("recurring_id", Check::String),
        ("user_id", Check::String),
        ("merchant_key", Check::String),
        ("merchant_name", Check::String),
        ("cadence", Check::String),
        ("is_income", Check::Boolean),
        ("status", Check::String),
        ("transaction_ids", Check::StringArray),
        ("label_budget_id", Check::NullableString),
        ("label_category_id", Check::NullableString),
        ("splits", Check::Custom(is_array)),
        ("splits_since", Check::NullableString),
        ("created_at", Check::NullableString),
        ("updated", Check::NullableString),
        ("is_deleted", Check::NullableBoolean),
    ],
    supports_soft_delete: true,
};

/// `recurringColumns`.
pub fn columns() -> Vec<&'static str> {
    TABLE.columns()
}

/// `toJSON()`: a `JSONRecurring`.
pub fn to_json(row: &Row) -> Json {
    Literal::new()
        .opt("recurring_id", row.get("recurring_id"))
        .opt("merchant_key", row.get("merchant_key"))
        .opt("merchant_name", row.get("merchant_name"))
        .opt("cadence", row.get("cadence"))
        .opt("is_income", row.get("is_income"))
        .opt("status", row.get("status"))
        .opt("transaction_ids", row.get("transaction_ids"))
        .set(
            "label",
            Literal::new().opt("budget_id", row.get("label_budget_id")).opt("category_id", row.get("label_category_id")),
        )
        .opt("splits", row.get("splits"))
        .opt("updated", row.get("updated"))
        .into()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::js_object::testing::{assert_json, obj};
    use super::*;

    fn row() -> Json {
        json!({
            "recurring_id": "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b",
            "user_id": "0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10",
            "merchant_key": "netflix",
            "merchant_name": "Netflix",
            "cadence": "monthly",
            "is_income": false,
            "status": "confirmed",
            "transaction_ids": ["tx-1", "tx-2"],
            "label_budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
            "label_category_id": null,
            "splits": [{ "amount": 5, "label": { "budget_id": null, "category_id": "c2a4b1de-7c64-4b6e-9e0a-6a1d2c3b4e5f" } }],
            "splits_since": "2026-03-01",
            "created_at": "2026-01-01T00:00:00.000Z",
            "updated": "2026-06-01T00:00:00.000Z",
            "is_deleted": false,
        })
    }

    #[test]
    fn to_json_nests_the_label_and_leaves_out_the_bookkeeping_columns() {
        let row = TABLE.validate(obj(row())).unwrap();
        assert_json(
            &to_json(&row),
            json!({
                "recurring_id": "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b",
                "merchant_key": "netflix",
                "merchant_name": "Netflix",
                "cadence": "monthly",
                "is_income": false,
                "status": "confirmed",
                "transaction_ids": ["tx-1", "tx-2"],
                "label": { "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77", "category_id": null },
                "splits": [{ "amount": 5, "label": { "budget_id": null, "category_id": "c2a4b1de-7c64-4b6e-9e0a-6a1d2c3b4e5f" } }],
                "updated": "2026-06-01T00:00:00.000Z",
            }),
        );
    }

    #[test]
    fn to_json_keeps_a_null_updated_and_an_unlabeled_recurring() {
        let mut row = obj(row());
        row.insert("updated".into(), Json::Null);
        row.insert("label_budget_id".into(), Json::Null);
        row.insert("splits".into(), json!([]));
        let json = to_json(&row);
        assert_eq!(json.get("updated"), Some(&Json::Null));
        assert_json(&json["label"], json!({ "budget_id": null, "category_id": null }));
        assert_eq!(json["splits"], json!([]));
    }

    #[test]
    fn splits_must_be_an_array_and_is_income_a_boolean() {
        let mut row = obj(row());
        row.insert("splits".into(), Json::Null);
        row.insert("is_income".into(), Json::Null);
        row.insert("transaction_ids".into(), json!(["tx-1", 2]));
        let error = TABLE.validate(row).unwrap_err().to_string();
        assert_eq!(
            error,
            "RecurringModel validation failed:\nis_income: null (object)\ntransaction_ids: [\"tx-1\",2] (object)\nsplits: null (object)"
        );

        let mut row = obj(self::row());
        row.insert("splits".into(), json!({}));
        assert!(TABLE.validate(row).is_err());
        let mut row = obj(self::row());
        row.shift_remove("splits");
        assert!(TABLE.validate(row).is_err());
    }

    #[test]
    fn one_recurring_per_merchant_and_direction() {
        assert_eq!(
            TABLE.constraints,
            ["CONSTRAINT recurrings_user_merchant_direction_unique UNIQUE (user_id, merchant_key, is_income)"]
        );
    }
}
