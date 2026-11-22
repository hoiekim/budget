//! `src/server/lib/postgres/models/institution.ts`.

use serde_json::json;

use super::base::{Check, Row, Table};
use super::js_object::Literal;
use crate::js::{Json, Obj};
use crate::server::postgres::database::QueryData;

pub static TABLE: Table = Table {
    name: "institutions",
    primary_key: "institution_id",
    schema: &[
        ("institution_id", "VARCHAR(255) PRIMARY KEY"),
        ("name", "VARCHAR(255)"),
        ("raw", "JSONB"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
    ],
    constraints: &[],
    indexes: &[],
    model: "InstitutionModel",
    checks: &[
        ("institution_id", Check::String),
        ("name", Check::NullableString),
        ("raw", Check::NullableObject),
        ("updated", Check::NullableString),
    ],
    supports_soft_delete: false,
};

/// `institutionColumns`.
pub fn columns() -> Vec<&'static str> {
    TABLE.columns()
}

/// `toJSON()`: a `JSONInstitution`. Only the id and the name come from the
/// row; the rest is what Plaid's shape requires, empty.
pub fn to_json(row: &Row) -> Json {
    Literal::new()
        .opt("institution_id", row.get("institution_id"))
        .opt("name", row.get("name"))
        .set("products", json!([]))
        .set("country_codes", json!([]))
        .set("url", Json::Null)
        .set("primary_color", Json::Null)
        .set("logo", Json::Null)
        .set("routing_numbers", json!([]))
        .set("oauth", false)
        .set("status", Json::Null)
        .into()
}

/// `fromJSON()`: the columns a (partial) `JSONInstitution` sets; `raw` keeps
/// the whole of what was given.
pub fn from_json(i: &Obj) -> QueryData {
    Literal::new().opt("institution_id", i.get("institution_id")).opt("name", i.get("name")).set("raw", i.clone()).into_obj()
}

#[cfg(test)]
mod tests {
    use super::super::js_object::testing::{assert_json, assert_row, obj};
    use super::*;

    fn row() -> Json {
        json!({
            "institution_id": "ins_3",
            "name": "Chase",
            "raw": { "institution_id": "ins_3", "name": "Chase", "oauth": true, "url": "https://www.chase.com" },
            "updated": "2026-06-01T00:00:00.000Z",
        })
    }

    #[test]
    fn to_json_fills_the_plaid_shape_with_empty_values() {
        let row = TABLE.validate(obj(row())).unwrap();
        assert_json(
            &to_json(&row),
            json!({
                "institution_id": "ins_3",
                "name": "Chase",
                "products": [],
                "country_codes": [],
                "url": null,
                "primary_color": null,
                "logo": null,
                "routing_numbers": [],
                "oauth": false,
                "status": null,
            }),
        );
    }

    #[test]
    fn to_json_keeps_a_null_name() {
        let mut row = obj(row());
        row.insert("name".into(), Json::Null);
        assert_eq!(to_json(&row).get("name"), Some(&Json::Null));
    }

    #[test]
    fn from_json_keeps_everything_as_raw() {
        let institution = obj(json!({
            "institution_id": "ins_3",
            "name": "Chase",
            "products": ["transactions"],
            "country_codes": ["US"],
            "url": "https://www.chase.com",
            "oauth": true,
        }));
        assert_row(
            &from_json(&institution),
            json!({
                "institution_id": "ins_3",
                "name": "Chase",
                "raw": {
                    "institution_id": "ins_3",
                    "name": "Chase",
                    "products": ["transactions"],
                    "country_codes": ["US"],
                    "url": "https://www.chase.com",
                    "oauth": true,
                },
            }),
        );
    }

    #[test]
    fn from_json_writes_null_but_not_undefined() {
        assert_row(&from_json(&obj(json!({ "name": null }))), json!({ "name": null, "raw": { "name": null } }));
        assert_row(&from_json(&Obj::new()), json!({ "raw": {} }));
    }
}
