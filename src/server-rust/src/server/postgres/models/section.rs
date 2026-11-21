//! `src/server/lib/postgres/models/section.ts`.

use super::base::{Check, IndexDefinition, Row, Table};
use super::js_object::{truthy_only, Literal};
use crate::js::{Json, Obj};
use crate::server::postgres::database::QueryData;

pub static TABLE: Table = Table {
    name: "sections",
    primary_key: "section_id",
    schema: &[
        ("section_id", "UUID PRIMARY KEY DEFAULT gen_random_uuid()"),
        ("user_id", "UUID REFERENCES users(user_id) ON DELETE RESTRICT NOT NULL"),
        ("budget_id", "UUID REFERENCES budgets(budget_id) ON DELETE RESTRICT NOT NULL"),
        ("name", "VARCHAR(255) DEFAULT 'Unnamed'"),
        ("roll_over", "BOOLEAN DEFAULT FALSE"),
        ("roll_over_start_date", "DATE"),
        ("capacities", "JSONB"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("is_deleted", "BOOLEAN DEFAULT FALSE"),
    ],
    constraints: &[],
    indexes: &[IndexDefinition::column("user_id"), IndexDefinition::column("budget_id")],
    model: "SectionModel",
    checks: &[
        ("section_id", Check::String),
        ("user_id", Check::String),
        ("budget_id", Check::String),
        ("name", Check::NullableString),
        ("roll_over", Check::NullableBoolean),
        ("roll_over_start_date", Check::NullableString),
        ("capacities", Check::NullableArray),
        ("updated", Check::NullableString),
        ("is_deleted", Check::NullableBoolean),
    ],
    supports_soft_delete: true,
};

/// `sectionColumns`.
pub fn columns() -> Vec<&'static str> {
    TABLE.columns()
}

/// `toJSON()`: a `JSONSection`, without `roll_over_start_date` when the row has none.
pub fn to_json(row: &Row) -> Json {
    Literal::new()
        .opt("section_id", row.get("section_id"))
        .opt("budget_id", row.get("budget_id"))
        .opt("name", row.get("name"))
        .opt("roll_over", row.get("roll_over"))
        .opt("roll_over_start_date", truthy_only(row.get("roll_over_start_date")))
        .opt("capacities", row.get("capacities"))
        .into()
}

/// `fromJSON()`: the columns a (partial) `JSONSection` sets. `capacities`
/// passes through as the array it is, for the driver to write as JSON.
pub fn from_json(s: &Obj, user_id: &str) -> QueryData {
    Literal::new()
        .set("user_id", user_id)
        .opt("section_id", s.get("section_id"))
        .opt("budget_id", s.get("budget_id"))
        .opt("name", s.get("name"))
        .opt("roll_over", s.get("roll_over"))
        .opt("roll_over_start_date", s.get("roll_over_start_date"))
        .opt("capacities", s.get("capacities"))
        .into_obj()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::js_object::testing::{assert_json, assert_row, obj};
    use super::*;

    fn row() -> Json {
        json!({
            "section_id": "9b0b7a5c-1a52-4c29-a1b5-2f6b1d1f0c11",
            "user_id": "0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10",
            "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
            "name": "Housing",
            "roll_over": false,
            "roll_over_start_date": null,
            "capacities": [{ "capacity_id": "cap-2", "month": 1800 }],
            "updated": "2026-06-01T00:00:00.000Z",
            "is_deleted": false,
        })
    }

    #[test]
    fn to_json_omits_a_missing_start_date() {
        let row = TABLE.validate(obj(row())).unwrap();
        assert_json(
            &to_json(&row),
            json!({
                "section_id": "9b0b7a5c-1a52-4c29-a1b5-2f6b1d1f0c11",
                "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
                "name": "Housing",
                "roll_over": false,
                "capacities": [{ "capacity_id": "cap-2", "month": 1800 }],
            }),
        );
    }

    #[test]
    fn to_json_keeps_a_start_date_between_roll_over_and_capacities() {
        let mut row = obj(row());
        row.insert("roll_over_start_date".into(), json!("2026-03-01"));
        row.insert("capacities".into(), Json::Null);
        assert_json(
            &to_json(&row),
            json!({
                "section_id": "9b0b7a5c-1a52-4c29-a1b5-2f6b1d1f0c11",
                "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
                "name": "Housing",
                "roll_over": false,
                "roll_over_start_date": "2026-03-01",
                "capacities": null,
            }),
        );
    }

    #[test]
    fn from_json_copies_what_is_given() {
        let section = obj(json!({
            "section_id": "9b0b7a5c-1a52-4c29-a1b5-2f6b1d1f0c11",
            "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
            "name": "Housing",
            "roll_over": true,
            "roll_over_start_date": "2026-03-01",
            "capacities": [],
        }));
        assert_row(
            &from_json(&section, "user-1"),
            json!({
                "user_id": "user-1",
                "section_id": "9b0b7a5c-1a52-4c29-a1b5-2f6b1d1f0c11",
                "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77",
                "name": "Housing",
                "roll_over": true,
                "roll_over_start_date": "2026-03-01",
                "capacities": [],
            }),
        );
    }

    #[test]
    fn from_json_writes_null_but_not_undefined() {
        let partial = obj(json!({ "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77", "roll_over_start_date": null }));
        assert_row(
            &from_json(&partial, "user-1"),
            json!({ "user_id": "user-1", "budget_id": "5d0c0f3e-0f3a-4d55-8f4b-0d3c5f1d9a77", "roll_over_start_date": null }),
        );
    }
}
