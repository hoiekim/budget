//! `src/server/lib/postgres/models/chart.ts`.

use super::base::{Check, IndexDefinition, Row, Table};
use super::js_object::Literal;
use crate::js::{json_parse, json_stringify, Json, Obj};
use crate::server::postgres::database::QueryData;

pub static TABLE: Table = Table {
    name: "charts",
    primary_key: "chart_id",
    schema: &[
        ("chart_id", "UUID PRIMARY KEY DEFAULT gen_random_uuid()"),
        ("user_id", "UUID REFERENCES users(user_id) ON DELETE RESTRICT"),
        ("name", "VARCHAR(255) DEFAULT 'Unnamed'"),
        ("type", "VARCHAR(50)"),
        ("configuration", "JSONB"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("is_deleted", "BOOLEAN DEFAULT FALSE"),
    ],
    constraints: &[],
    indexes: &[IndexDefinition::column("user_id")],
    model: "ChartModel",
    checks: &[
        ("chart_id", Check::String),
        ("user_id", Check::String),
        ("name", Check::NullableString),
        ("type", Check::NullableString),
        ("configuration", Check::NullableObject),
        ("updated", Check::NullableString),
        ("is_deleted", Check::NullableBoolean),
    ],
    supports_soft_delete: true,
};

/// `chartColumns`.
pub fn columns() -> Vec<&'static str> {
    TABLE.columns()
}

/// The conversion the `ChartModel` constructor makes: the driver parses the
/// JSONB column, and a `JSONChart` carries the configuration as JSON text.
/// `typeof null` is `"object"` as well, so an empty column reads as the text
/// `null`.
fn configuration_text(configuration: Option<&Json>) -> Option<Json> {
    match configuration {
        Some(value @ (Json::Null | Json::Object(_) | Json::Array(_))) => Some(Json::String(json_stringify(value))),
        other => other.cloned(),
    }
}

/// `toJSON()`: a `JSONChart`, its `configuration` as JSON text.
pub fn to_json(row: &Row) -> Json {
    Literal::new()
        .opt("chart_id", row.get("chart_id"))
        .opt("name", row.get("name"))
        .opt("type", row.get("type"))
        .opt("configuration", configuration_text(row.get("configuration")).as_ref())
        .into()
}

/// `fromJSON()`: the columns a (partial) `JSONChart` sets. The client sends
/// `configuration` as JSON text, which is parsed to the value the JSONB
/// column stores; text that is not JSON is an error, where the TypeScript
/// throws out of `JSON.parse`, and the write is refused.
pub fn from_json(c: &Obj, user_id: &str) -> anyhow::Result<QueryData> {
    let configuration = match c.get("configuration") {
        Some(Json::String(text)) => {
            Some(json_parse(text).ok_or_else(|| anyhow::anyhow!("The chart configuration is not valid JSON"))?)
        }
        other => other.cloned(),
    };
    Ok(Literal::new()
        .set("user_id", user_id)
        .opt("chart_id", c.get("chart_id"))
        .opt("name", c.get("name"))
        .opt("type", c.get("type"))
        .opt("configuration", configuration.as_ref())
        .into_obj())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::js_object::testing::{assert_json, assert_row, obj};
    use super::*;

    fn row() -> Json {
        json!({
            "chart_id": "7f9d6c1b-2a3e-4f50-8b7a-9c0d1e2f3a4b",
            "user_id": "0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10",
            "name": "Net worth",
            "type": "balance_chart",
            "configuration": { "account_ids": ["acc-checking", "acc-savings"], "budget_ids": [] },
            "updated": "2026-06-01T00:00:00.000Z",
            "is_deleted": false,
        })
    }

    #[test]
    fn to_json_carries_the_configuration_as_json_text() {
        let row = TABLE.validate(obj(row())).unwrap();
        assert_json(
            &to_json(&row),
            json!({
                "chart_id": "7f9d6c1b-2a3e-4f50-8b7a-9c0d1e2f3a4b",
                "name": "Net worth",
                "type": "balance_chart",
                "configuration": "{\"account_ids\":[\"acc-checking\",\"acc-savings\"],\"budget_ids\":[]}",
            }),
        );
    }

    #[test]
    fn to_json_reads_an_empty_configuration_as_the_text_null() {
        let mut row = obj(row());
        row.insert("configuration".into(), Json::Null);
        row.insert("type".into(), Json::Null);
        assert_json(
            &to_json(&row),
            json!({ "chart_id": "7f9d6c1b-2a3e-4f50-8b7a-9c0d1e2f3a4b", "name": "Net worth", "type": null, "configuration": "null" }),
        );
        row.insert("configuration".into(), json!([1, "two"]));
        assert_eq!(to_json(&row)["configuration"], json!("[1,\"two\"]"));
    }

    #[test]
    fn from_json_parses_configuration_text() {
        let chart = obj(json!({
            "chart_id": "7f9d6c1b-2a3e-4f50-8b7a-9c0d1e2f3a4b",
            "name": "Projection",
            "type": "projection_chart",
            "configuration": "{\"account_ids\":[\"acc-1\"],\"contribution\":500.0,\"anual_percentage_yield\":1.07}",
        }));
        assert_row(
            &from_json(&chart, "user-1").unwrap(),
            json!({
                "user_id": "user-1",
                "chart_id": "7f9d6c1b-2a3e-4f50-8b7a-9c0d1e2f3a4b",
                "name": "Projection",
                "type": "projection_chart",
                "configuration": { "account_ids": ["acc-1"], "contribution": 500, "anual_percentage_yield": 1.07 },
            }),
        );
    }

    #[test]
    fn from_json_passes_a_configuration_that_is_not_text_through() {
        let parsed = obj(json!({ "configuration": { "account_ids": [] } }));
        assert_row(&from_json(&parsed, "user-1").unwrap(), json!({ "user_id": "user-1", "configuration": { "account_ids": [] } }));

        // `null` is given, so it is written; an absent key is not.
        let cleared = obj(json!({ "name": "Renamed", "configuration": null }));
        assert_row(&from_json(&cleared, "user-1").unwrap(), json!({ "user_id": "user-1", "name": "Renamed", "configuration": null }));
        assert_row(&from_json(&obj(json!({ "name": "Renamed" })), "user-1").unwrap(), json!({ "user_id": "user-1", "name": "Renamed" }));

        // The text `null` parses to null as well.
        let null_text = obj(json!({ "configuration": "null" }));
        assert_row(&from_json(&null_text, "user-1").unwrap(), json!({ "user_id": "user-1", "configuration": null }));
    }

    #[test]
    fn from_json_refuses_configuration_text_that_is_not_json() {
        let malformed = obj(json!({ "chart_id": "c-1", "configuration": "{account_ids" }));
        assert!(from_json(&malformed, "user-1").is_err());
        assert!(from_json(&obj(json!({ "configuration": "" })), "user-1").is_err());
    }
}
