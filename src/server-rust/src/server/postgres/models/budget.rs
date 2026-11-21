//! `src/server/lib/postgres/models/budget.ts`.

use super::base::{Check, IndexDefinition, Row, Table};
use super::js_object::{truthy_only, Literal};
use crate::js::{Json, Obj};
use crate::server::postgres::database::QueryData;

pub static TABLE: Table = Table {
    name: "budgets",
    primary_key: "budget_id",
    schema: &[
        ("budget_id", "UUID PRIMARY KEY DEFAULT gen_random_uuid()"),
        ("user_id", "UUID REFERENCES users(user_id) ON DELETE RESTRICT NOT NULL"),
        ("name", "VARCHAR(255) DEFAULT 'Unnamed'"),
        ("iso_currency_code", "VARCHAR(10) DEFAULT 'USD'"),
        ("roll_over", "BOOLEAN DEFAULT FALSE"),
        ("roll_over_start_date", "DATE"),
        ("capacities", "JSONB"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("is_deleted", "BOOLEAN DEFAULT FALSE"),
    ],
    constraints: &[],
    indexes: &[IndexDefinition::column("user_id")],
    model: "BudgetModel",
    checks: &[
        ("budget_id", Check::String),
        ("user_id", Check::String),
        ("name", Check::NullableString),
        ("iso_currency_code", Check::NullableString),
        ("roll_over", Check::NullableBoolean),
        ("roll_over_start_date", Check::NullableString),
        ("capacities", Check::NullableArray),
        ("updated", Check::NullableString),
        ("is_deleted", Check::NullableBoolean),
    ],
    supports_soft_delete: true,
};

/// `budgetColumns`.
pub fn columns() -> Vec<&'static str> {
    TABLE.columns()
}

/// `toJSON()`: a `JSONBudget`, without `roll_over_start_date` when the row has none.
pub fn to_json(row: &Row) -> Json {
    Literal::new()
        .opt("budget_id", row.get("budget_id"))
        .opt("name", row.get("name"))
        .opt("iso_currency_code", row.get("iso_currency_code"))
        .opt("roll_over", row.get("roll_over"))
        .opt("roll_over_start_date", truthy_only(row.get("roll_over_start_date")))
        .opt("capacities", row.get("capacities"))
        .into()
}

/// `fromJSON()`: the columns a (partial) `JSONBudget` sets. `capacities`
/// passes through as the array it is, for the driver to write as JSON.
pub fn from_json(b: &Obj, user_id: &str) -> QueryData {
    Literal::new()
        .set("user_id", user_id)
        .opt("budget_id", b.get("budget_id"))
        .opt("name", b.get("name"))
        .opt("iso_currency_code", b.get("iso_currency_code"))
        .opt("roll_over", b.get("roll_over"))
        .opt("roll_over_start_date", b.get("roll_over_start_date"))
        .opt("capacities", b.get("capacities"))
        .into_obj()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::js_object::testing::{assert_json, assert_row, obj};
    use super::*;

    fn row() -> Json {
        json!({
            "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
            "user_id": "0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10",
            "name": "Household",
            "iso_currency_code": "USD",
            "roll_over": true,
            "roll_over_start_date": "2026-01-01",
            "capacities": [{ "capacity_id": "cap-1", "month": 3200, "active_from": "2026-01-01", "is_synced": true }],
            "updated": "2026-06-01T00:00:00.000Z",
            "is_deleted": false,
        })
    }

    #[test]
    fn to_json_drops_the_owner_and_bookkeeping_columns() {
        let row = TABLE.validate(obj(row())).unwrap();
        assert_json(
            &to_json(&row),
            json!({
                "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
                "name": "Household",
                "iso_currency_code": "USD",
                "roll_over": true,
                "roll_over_start_date": "2026-01-01",
                "capacities": [{ "capacity_id": "cap-1", "month": 3200, "active_from": "2026-01-01", "is_synced": true }],
            }),
        );
    }

    #[test]
    fn to_json_omits_a_missing_start_date_and_keeps_other_nulls() {
        let mut row = obj(row());
        row.insert("roll_over_start_date".into(), Json::Null);
        row.insert("capacities".into(), Json::Null);
        row.insert("name".into(), Json::Null);
        assert_json(
            &to_json(&row),
            json!({
                "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
                "name": null,
                "iso_currency_code": "USD",
                "roll_over": true,
                "capacities": null,
            }),
        );
    }

    #[test]
    fn from_json_copies_what_is_given() {
        let budget = obj(json!({
            "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
            "name": "Household",
            "iso_currency_code": "USD",
            "roll_over": false,
            "roll_over_start_date": "2026-01-01",
            "capacities": [{ "capacity_id": "cap-1", "month": 3200 }],
        }));
        assert_row(
            &from_json(&budget, "user-1"),
            json!({
                "user_id": "user-1",
                "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
                "name": "Household",
                "iso_currency_code": "USD",
                "roll_over": false,
                "roll_over_start_date": "2026-01-01",
                "capacities": [{ "capacity_id": "cap-1", "month": 3200 }],
            }),
        );
    }

    #[test]
    fn from_json_writes_null_but_not_undefined() {
        let partial = obj(json!({ "name": "Renamed", "roll_over_start_date": null }));
        assert_row(&from_json(&partial, "user-1"), json!({ "user_id": "user-1", "name": "Renamed", "roll_over_start_date": null }));
        assert_row(&from_json(&Obj::new(), "user-1"), json!({ "user_id": "user-1" }));
    }
}
