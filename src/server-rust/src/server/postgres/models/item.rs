//! `src/server/lib/postgres/models/item.ts`.

use super::base::{Check, IndexDefinition, Row, Table};
use super::js_object::{truthy_only, Literal};
use crate::js::{Json, Obj};
use crate::server::postgres::database::QueryData;

pub static TABLE: Table = Table {
    name: "items",
    primary_key: "item_id",
    schema: &[
        ("item_id", "VARCHAR(255) PRIMARY KEY"),
        ("user_id", "UUID REFERENCES users(user_id) ON DELETE RESTRICT NOT NULL"),
        ("access_token", "VARCHAR(255)"),
        ("institution_id", "VARCHAR(255)"),
        ("available_products", "TEXT[]"),
        ("cursor", "TEXT"),
        ("status", "VARCHAR(50)"),
        ("status_reason", "VARCHAR(50)"),
        ("provider", "VARCHAR(50)"),
        ("last_sync_status", "VARCHAR(20)"),
        ("last_sync_at", "TIMESTAMPTZ"),
        ("last_sync_error", "TEXT"),
        ("raw", "JSONB"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("is_deleted", "BOOLEAN DEFAULT FALSE"),
    ],
    constraints: &[],
    indexes: &[IndexDefinition::column("user_id"), IndexDefinition::column("institution_id")],
    model: "ItemModel",
    checks: &[
        ("item_id", Check::String),
        ("user_id", Check::String),
        ("access_token", Check::NullableString),
        ("institution_id", Check::NullableString),
        ("available_products", Check::NullableArray),
        ("cursor", Check::NullableString),
        ("status", Check::NullableString),
        ("status_reason", Check::NullableString),
        ("provider", Check::NullableString),
        ("last_sync_status", Check::NullableString),
        ("last_sync_at", Check::NullableString),
        ("last_sync_error", Check::NullableString),
        ("raw", Check::NullableObject),
        ("updated", Check::NullableString),
        ("is_deleted", Check::NullableBoolean),
    ],
    supports_soft_delete: true,
};

/// `itemColumns`.
pub fn columns() -> Vec<&'static str> {
    TABLE.columns()
}

/// `toJSON()`: a `JSONItem`, access token included. The optional fields are
/// left out when the row has nothing (or an empty string) for them.
pub fn to_json(row: &Row) -> Json {
    Literal::new()
        .opt("item_id", row.get("item_id"))
        .opt("user_id", row.get("user_id"))
        .opt("access_token", row.get("access_token"))
        .opt("institution_id", row.get("institution_id"))
        .opt("available_products", row.get("available_products"))
        .opt("cursor", truthy_only(row.get("cursor")))
        .opt("status", truthy_only(row.get("status")))
        .opt("status_reason", truthy_only(row.get("status_reason")))
        .opt("provider", row.get("provider"))
        .opt("updated", truthy_only(row.get("updated")))
        .opt("last_sync_status", truthy_only(row.get("last_sync_status")))
        .opt("last_sync_at", truthy_only(row.get("last_sync_at")))
        .opt("last_sync_error", truthy_only(row.get("last_sync_error")))
        .into()
}

/// `fromJSON()`: the columns a (partial) `JSONItem` sets; `raw` keeps the
/// whole of what was given. An empty `institution_id` is written as NULL.
pub fn from_json(item: &Obj, user_id: &str) -> QueryData {
    // `item.institution_id || null`
    let institution_id = item.get("institution_id").map(|id| truthy_only(Some(id)).cloned().unwrap_or(Json::Null));
    Literal::new()
        .opt("item_id", item.get("item_id"))
        .set("user_id", user_id)
        .opt("access_token", item.get("access_token"))
        .opt("institution_id", institution_id.as_ref())
        .opt("available_products", item.get("available_products"))
        .opt("cursor", item.get("cursor"))
        .opt("status", item.get("status"))
        .opt("status_reason", item.get("status_reason"))
        .opt("provider", item.get("provider"))
        .opt("last_sync_status", item.get("last_sync_status"))
        .opt("last_sync_at", item.get("last_sync_at"))
        .opt("last_sync_error", item.get("last_sync_error"))
        .set("raw", item.clone())
        .into_obj()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::js_object::testing::{assert_json, assert_row, obj};
    use super::*;

    fn row() -> Json {
        json!({
            "item_id": "item-1",
            "user_id": "0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10",
            "access_token": "access-production-123",
            "institution_id": "ins_3",
            "available_products": ["transactions", "investments"],
            "cursor": "cursor-abc",
            "status": "ok",
            "status_reason": null,
            "provider": "plaid",
            "last_sync_status": "success",
            "last_sync_at": "2026-06-01T08:00:00.000Z",
            "last_sync_error": null,
            "raw": { "item_id": "item-1" },
            "updated": "2026-06-01T08:00:01.000Z",
            "is_deleted": false,
        })
    }

    #[test]
    fn to_json_leaves_out_the_optional_fields_the_row_lacks() {
        let row = TABLE.validate(obj(row())).unwrap();
        assert_json(
            &to_json(&row),
            json!({
                "item_id": "item-1",
                "user_id": "0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10",
                "access_token": "access-production-123",
                "institution_id": "ins_3",
                "available_products": ["transactions", "investments"],
                "cursor": "cursor-abc",
                "status": "ok",
                "provider": "plaid",
                "updated": "2026-06-01T08:00:01.000Z",
                "last_sync_status": "success",
                "last_sync_at": "2026-06-01T08:00:00.000Z",
            }),
        );
    }

    #[test]
    fn to_json_omits_falsy_optionals_and_keeps_null_required_fields() {
        let row = obj(json!({
            "item_id": "manual-1",
            "user_id": "0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10",
            "access_token": null,
            "institution_id": null,
            "available_products": null,
            "cursor": "",
            "status": null,
            "status_reason": "",
            "provider": null,
            "last_sync_status": null,
            "last_sync_at": null,
            "last_sync_error": "",
            "raw": null,
            "updated": null,
            "is_deleted": null,
        }));
        let row = TABLE.validate(row).unwrap();
        assert_json(
            &to_json(&row),
            json!({
                "item_id": "manual-1",
                "user_id": "0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10",
                "access_token": null,
                "institution_id": null,
                "available_products": null,
                "provider": null,
            }),
        );
    }

    #[test]
    fn from_json_keeps_the_whole_item_as_raw() {
        let item = obj(json!({
            "item_id": "item-1",
            "access_token": "access-production-123",
            "institution_id": "ins_3",
            "available_products": ["transactions"],
            "cursor": "cursor-abc",
            "status": "ok",
            "provider": "plaid",
            "updated": "2026-06-01",
        }));
        assert_row(
            &from_json(&item, "user-1"),
            json!({
                "item_id": "item-1",
                "user_id": "user-1",
                "access_token": "access-production-123",
                "institution_id": "ins_3",
                "available_products": ["transactions"],
                "cursor": "cursor-abc",
                "status": "ok",
                "provider": "plaid",
                "raw": {
                    "item_id": "item-1",
                    "access_token": "access-production-123",
                    "institution_id": "ins_3",
                    "available_products": ["transactions"],
                    "cursor": "cursor-abc",
                    "status": "ok",
                    "provider": "plaid",
                    "updated": "2026-06-01",
                },
            }),
        );
    }

    #[test]
    fn from_json_nulls_an_empty_institution_and_keeps_given_nulls() {
        let item = obj(json!({ "item_id": "item-1", "institution_id": "", "cursor": null, "status_reason": "", "last_sync_error": null }));
        assert_row(
            &from_json(&item, "user-1"),
            json!({
                "item_id": "item-1",
                "user_id": "user-1",
                "institution_id": null,
                "cursor": null,
                "status_reason": "",
                "last_sync_error": null,
                "raw": { "item_id": "item-1", "institution_id": "", "cursor": null, "status_reason": "", "last_sync_error": null },
            }),
        );

        // Nothing given, nothing set: not even the id.
        assert_row(&from_json(&Obj::new(), "user-1"), json!({ "user_id": "user-1", "raw": {} }));
    }
}
