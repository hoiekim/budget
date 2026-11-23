//! `src/server/lib/postgres/models/user.ts`.

use serde_json::json;

use super::base::{str_of, Check, IndexDefinition, IndexKey, Row, Table};
use crate::js::Json;

/// A user as the rest of the app may see one: no password.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MaskedUser {
    pub user_id: String,
    pub username: String,
}

impl MaskedUser {
    pub fn to_json(&self) -> Json {
        json!({ "user_id": self.user_id, "username": self.username })
    }
}

#[derive(Clone, Debug)]
pub struct User {
    pub user_id: String,
    pub username: String,
    pub password: String,
}

pub static TABLE: Table = Table {
    name: "users",
    primary_key: "user_id",
    schema: &[
        ("user_id", "UUID PRIMARY KEY DEFAULT gen_random_uuid()"),
        ("username", "VARCHAR(255) UNIQUE NOT NULL"),
        ("password", "VARCHAR(255)"),
        ("email", "VARCHAR(255)"),
        ("expiry", "TIMESTAMPTZ"),
        ("token", "VARCHAR(255)"),
        ("auth_sub", "TEXT UNIQUE"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("is_deleted", "BOOLEAN DEFAULT FALSE"),
    ],
    constraints: &[],
    indexes: &[IndexDefinition {
        key: IndexKey::Expression { expression: "lower(email)", name: "idx_users_lower_email" },
        unique: true,
        predicate: Some("email IS NOT NULL"),
    }],
    model: "UserModel",
    checks: &[
        ("user_id", Check::String),
        ("username", Check::String),
        ("password", Check::NullableString),
        ("email", Check::NullableString),
        ("expiry", Check::NullableString),
        ("token", Check::NullableString),
        ("auth_sub", Check::NullableString),
        ("updated", Check::NullableString),
        ("is_deleted", Check::NullableBoolean),
    ],
    supports_soft_delete: true,
};

/// `toMaskedUser()` / `toJSON()`.
pub fn to_masked_user(row: &Row) -> MaskedUser {
    MaskedUser { user_id: str_of(row, "user_id").to_string(), username: str_of(row, "username").to_string() }
}

/// `toUser()`: an error for a user with no password set.
pub fn to_user(row: &Row) -> anyhow::Result<User> {
    match row.get("password").and_then(|p| p.as_str()) {
        Some(password) => Ok(User {
            user_id: str_of(row, "user_id").to_string(),
            username: str_of(row, "username").to_string(),
            password: password.to_string(),
        }),
        None => anyhow::bail!("User has no password set"),
    }
}
