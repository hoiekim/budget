//! `src/server/lib/postgres/models/category.ts`.

use super::base::{Check, IndexDefinition, Row, Table};
use super::js_object::{truthy_only, Literal};
use crate::js::{Json, Obj};
use crate::server::postgres::database::QueryData;

pub static TABLE: Table = Table {
    name: "categories",
    primary_key: "category_id",
    schema: &[
        ("category_id", "UUID PRIMARY KEY DEFAULT gen_random_uuid()"),
        ("user_id", "UUID REFERENCES users(user_id) ON DELETE RESTRICT NOT NULL"),
        ("section_id", "UUID REFERENCES sections(section_id) ON DELETE RESTRICT NOT NULL"),
        ("name", "VARCHAR(255) DEFAULT 'Unnamed'"),
        ("roll_over", "BOOLEAN DEFAULT FALSE"),
        ("roll_over_start_date", "DATE"),
        ("capacities", "JSONB"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("is_deleted", "BOOLEAN DEFAULT FALSE"),
    ],
    constraints: &[],
    indexes: &[IndexDefinition::column("user_id"), IndexDefinition::column("section_id")],
    model: "CategoryModel",
    checks: &[
        ("category_id", Check::String),
        ("user_id", Check::String),
        ("section_id", Check::String),
        ("name", Check::NullableString),
        ("roll_over", Check::NullableBoolean),
        ("roll_over_start_date", Check::NullableString),
        ("capacities", Check::NullableArray),
        ("updated", Check::NullableString),
        ("is_deleted", Check::NullableBoolean),
    ],
    supports_soft_delete: true,
};

/// `categoryColumns`.
pub fn columns() -> Vec<&'static str> {
    TABLE.columns()
}

/// `toJSON()`: a `JSONCategory`, without `roll_over_start_date` when the row has none.
pub fn to_json(row: &Row) -> Json {
    Literal::new()
        .opt("category_id", row.get("category_id"))
        .opt("section_id", row.get("section_id"))
        .opt("name", row.get("name"))
        .opt("roll_over", row.get("roll_over"))
        .opt("roll_over_start_date", truthy_only(row.get("roll_over_start_date")))
        .opt("capacities", row.get("capacities"))
        .into()
}

/// `fromJSON()`: the columns a (partial) `JSONCategory` sets. `capacities`
/// passes through as the array it is, for the driver to write as JSON.
pub fn from_json(c: &Obj, user_id: &str) -> QueryData {
    Literal::new()
        .set("user_id", user_id)
        .opt("category_id", c.get("category_id"))
        .opt("section_id", c.get("section_id"))
        .opt("name", c.get("name"))
        .opt("roll_over", c.get("roll_over"))
        .opt("roll_over_start_date", c.get("roll_over_start_date"))
        .opt("capacities", c.get("capacities"))
        .into_obj()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::js_object::testing::{assert_json, assert_row, obj};
    use super::*;

    fn row() -> Json {
        json!({
            "category_id": "c2a4b1de-7c64-4b6e-9e0a-6a1d2c3b4e5f",
            "user_id": "0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10",
            "section_id": "9b0b7a5c-1a52-4c29-a1b5-2f6b1d1f0c11",
            "name": "Rent",
            "roll_over": true,
            "roll_over_start_date": "2026-02-01",
            "capacities": [{ "capacity_id": "cap-3", "month": 1500.25, "active_from": "2026-02-01" }],
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
                "category_id": "c2a4b1de-7c64-4b6e-9e0a-6a1d2c3b4e5f",
                "section_id": "9b0b7a5c-1a52-4c29-a1b5-2f6b1d1f0c11",
                "name": "Rent",
                "roll_over": true,
                "roll_over_start_date": "2026-02-01",
                "capacities": [{ "capacity_id": "cap-3", "month": 1500.25, "active_from": "2026-02-01" }],
            }),
        );
    }

    #[test]
    fn to_json_omits_a_missing_start_date_and_keeps_other_nulls() {
        let mut row = obj(row());
        row.insert("roll_over_start_date".into(), Json::Null);
        row.insert("roll_over".into(), Json::Null);
        let json = to_json(&row);
        assert!(json.get("roll_over_start_date").is_none());
        assert_eq!(json.get("roll_over"), Some(&Json::Null));
    }

    #[test]
    fn from_json_copies_what_is_given() {
        let category = obj(json!({
            "category_id": "c2a4b1de-7c64-4b6e-9e0a-6a1d2c3b4e5f",
            "section_id": "9b0b7a5c-1a52-4c29-a1b5-2f6b1d1f0c11",
            "name": "Rent",
            "roll_over": true,
            "roll_over_start_date": "2026-02-01",
            "capacities": [{ "capacity_id": "cap-3", "month": 1500.25 }],
        }));
        assert_row(
            &from_json(&category, "user-1"),
            json!({
                "user_id": "user-1",
                "category_id": "c2a4b1de-7c64-4b6e-9e0a-6a1d2c3b4e5f",
                "section_id": "9b0b7a5c-1a52-4c29-a1b5-2f6b1d1f0c11",
                "name": "Rent",
                "roll_over": true,
                "roll_over_start_date": "2026-02-01",
                "capacities": [{ "capacity_id": "cap-3", "month": 1500.25 }],
            }),
        );
    }

    #[test]
    fn from_json_writes_null_but_not_undefined() {
        let partial = obj(json!({ "name": null, "capacities": null }));
        assert_row(&from_json(&partial, "user-1"), json!({ "user_id": "user-1", "name": null, "capacities": null }));
    }
}
