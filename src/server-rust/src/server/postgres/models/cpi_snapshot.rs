//! `src/server/lib/postgres/models/cpi_snapshot.ts`.
//!
//! Monthly Consumer Price Index observations from the scheduled BLS refresh.
//! Global (no `user_id`); see docs/ARCHITECTURE.md, "BLS".

use super::base::{Check, IndexDefinition, Row, Table};
use super::js_object::{interpolate, Literal};
use crate::js::{js_slice_start, to_js_string, Json, Obj};
use crate::server::postgres::database::QueryData;

pub static TABLE: Table = Table {
    name: "cpi_snapshots",
    primary_key: "cpi_snapshot_id",
    schema: &[
        ("cpi_snapshot_id", "VARCHAR(255) PRIMARY KEY"),
        ("series_id", "VARCHAR(50) NOT NULL"),
        ("snapshot_date", "DATE NOT NULL"),
        ("index_value", "DECIMAL(15, 6) NOT NULL"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
    ],
    constraints: &[],
    indexes: &[IndexDefinition::column("series_id")],
    model: "CpiSnapshotModel",
    checks: &[
        ("cpi_snapshot_id", Check::String),
        ("series_id", Check::String),
        ("snapshot_date", Check::String),
        ("index_value", Check::Number),
        ("updated", Check::NullableString),
    ],
    supports_soft_delete: false,
};

/// `cpiSnapshotColumns`.
pub fn columns() -> Vec<&'static str> {
    TABLE.columns()
}

/// The month of a date: `date.slice(0, 7)`.
fn month_of(date: &str) -> String {
    js_slice_start(date, 7)
}

/// `getCpiSnapshotId()`: one row per series and month.
pub fn get_cpi_snapshot_id(series_id: &str, date: &str) -> String {
    format!("{series_id}-{}", month_of(date))
}

/// `toJSON()`: a `JSONCpiSnapshot`.
pub fn to_json(row: &Row) -> Json {
    Literal::new()
        .opt("series_id", row.get("series_id"))
        .opt("date", row.get("snapshot_date"))
        .opt("value", row.get("index_value"))
        .opt("updated", row.get("updated"))
        .into()
}

/// `fromJSON()`: the row of a `JSONCpiSnapshot`, its id derived from the
/// series and the month.
///
/// `date` must be a string, as `JSONCpiSnapshot` declares. Anything else is
/// an error, where the TypeScript throws calling `date.slice`; except an
/// array, which has a `slice` of its own.
pub fn from_json(s: &Obj) -> anyhow::Result<QueryData> {
    let month = match s.get("date") {
        Some(Json::String(date)) => month_of(date),
        Some(Json::Array(items)) => to_js_string(&Json::Array(items.iter().take(7).cloned().collect())),
        _ => anyhow::bail!("A CPI snapshot's date must be a string"),
    };
    let cpi_snapshot_id = format!("{}-{month}", interpolate(s.get("series_id")));
    Ok(Literal::new()
        .set("cpi_snapshot_id", cpi_snapshot_id)
        .opt("series_id", s.get("series_id"))
        .opt("snapshot_date", s.get("date"))
        .opt("index_value", s.get("value"))
        .into_obj())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::js_object::testing::{assert_json, assert_row, obj};
    use super::*;

    fn row() -> Json {
        json!({
            "cpi_snapshot_id": "CUUR0000SA0-2026-09",
            "series_id": "CUUR0000SA0",
            "snapshot_date": "2026-09-01",
            "index_value": 324.5,
            "updated": "2026-10-15T12:00:00.000Z",
        })
    }

    // `repositories/cpi_snapshots.test.ts`, "one row per series and month".
    #[test]
    fn the_id_is_the_series_and_the_month() {
        assert_eq!(get_cpi_snapshot_id("CUUR0000SA0", "2026-09-01"), "CUUR0000SA0-2026-09");
        assert_eq!(get_cpi_snapshot_id("CUUR0000SA0", "2026"), "CUUR0000SA0-2026");
    }

    #[test]
    fn to_json_renames_the_columns() {
        let row = TABLE.validate(obj(row())).unwrap();
        assert_json(
            &to_json(&row),
            json!({ "series_id": "CUUR0000SA0", "date": "2026-09-01", "value": 324.5, "updated": "2026-10-15T12:00:00.000Z" }),
        );
    }

    #[test]
    fn to_json_keeps_a_null_updated() {
        let mut row = obj(row());
        row.insert("updated".into(), Json::Null);
        assert_json(&to_json(&row), json!({ "series_id": "CUUR0000SA0", "date": "2026-09-01", "value": 324.5, "updated": null }));
    }

    #[test]
    fn a_row_needs_a_number_for_its_value() {
        let mut row = obj(row());
        row.insert("index_value".into(), Json::Null);
        let error = TABLE.validate(row).unwrap_err().to_string();
        assert_eq!(error, "CpiSnapshotModel validation failed:\nindex_value: null (object)");
    }

    #[test]
    fn from_json_derives_the_id_and_leaves_updated_to_the_database() {
        let snapshot = obj(json!({ "series_id": "CUUR0000SA0", "date": "2026-09-01", "value": 324.5, "updated": "2026-10-15T12:00:00.000Z" }));
        assert_row(
            &from_json(&snapshot).unwrap(),
            json!({ "cpi_snapshot_id": "CUUR0000SA0-2026-09", "series_id": "CUUR0000SA0", "snapshot_date": "2026-09-01", "index_value": 324.5 }),
        );
    }

    #[test]
    fn from_json_leaves_out_what_is_undefined_and_writes_null() {
        let snapshot = obj(json!({ "date": "2026-09-01", "value": null }));
        assert_row(&from_json(&snapshot).unwrap(), json!({ "cpi_snapshot_id": "undefined-2026-09", "snapshot_date": "2026-09-01", "index_value": null }));
    }

    #[test]
    fn from_json_needs_a_date_to_take_the_month_of() {
        assert!(from_json(&obj(json!({ "series_id": "CUUR0000SA0", "value": 324.5 }))).is_err());
        assert!(from_json(&obj(json!({ "series_id": "CUUR0000SA0", "date": null, "value": 324.5 }))).is_err());
        assert!(from_json(&obj(json!({ "series_id": "CUUR0000SA0", "date": 20260901, "value": 324.5 }))).is_err());

        // An array can be sliced too, and the template joins what is left of it.
        let listed = obj(json!({ "series_id": "S", "date": ["a", "b"], "value": 1 }));
        assert_eq!(from_json(&listed).unwrap()["cpi_snapshot_id"], json!("S-a,b"));
    }
}
