//! `src/server/lib/postgres/models/api_key.ts`.

use serde_json::json;

use super::base::{value_of, Check, IndexDefinition, Row, Table};
use crate::js::Json;

pub static TABLE: Table = Table {
    name: "api_keys",
    primary_key: "key_id",
    schema: &[
        ("key_id", "UUID PRIMARY KEY DEFAULT gen_random_uuid()"),
        ("user_id", "UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE"),
        ("name", "VARCHAR(255) NOT NULL"),
        ("key_hash", "VARCHAR(64) UNIQUE NOT NULL"),
        ("key_prefix", "VARCHAR(16) NOT NULL"),
        ("scopes", "TEXT[] NOT NULL DEFAULT '{}'"),
        ("created_at", "TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP"),
        ("last_used_at", "TIMESTAMPTZ"),
        ("revoked_at", "TIMESTAMPTZ"),
        ("expires_at", "TIMESTAMPTZ"),
        // Framework-required: the insert and update builders always touch this column.
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
    ],
    constraints: &[],
    indexes: &[IndexDefinition::column("user_id"), IndexDefinition::column("key_hash")],
    model: "ApiKeyModel",
    checks: &[
        ("key_id", Check::String),
        ("user_id", Check::String),
        ("name", Check::String),
        ("key_hash", Check::String),
        ("key_prefix", Check::String),
        ("scopes", Check::StringArray),
        ("created_at", Check::String),
        ("last_used_at", Check::NullableString),
        ("revoked_at", Check::NullableString),
        ("expires_at", Check::NullableString),
        ("updated", Check::NullableString),
    ],
    supports_soft_delete: false,
};

/// `toJSON()`: everything but the hash.
pub fn to_json(row: &Row) -> Json {
    json!({
        "key_id": value_of(row, "key_id"),
        "user_id": value_of(row, "user_id"),
        "name": value_of(row, "name"),
        "key_prefix": value_of(row, "key_prefix"),
        "scopes": value_of(row, "scopes"),
        "created_at": value_of(row, "created_at"),
        "last_used_at": value_of(row, "last_used_at"),
        "revoked_at": value_of(row, "revoked_at"),
        "expires_at": value_of(row, "expires_at"),
    })
}
