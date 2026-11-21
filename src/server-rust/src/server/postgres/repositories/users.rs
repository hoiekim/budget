//! `src/server/lib/postgres/repositories/users.ts`.

use serde_json::json;

use crate::filters;
use crate::js::{Json, Obj};
use crate::server::password::hash_password;
use crate::server::postgres::database::{AdditionalWhere, SearchFilters};
use crate::server::postgres::models::user::{self, MaskedUser, User};
use crate::server::postgres::models::{Row, UpdateArgs};

pub fn mask_user(user: &User) -> MaskedUser {
    MaskedUser { user_id: user.user_id.clone(), username: user.username.clone() }
}

/// Creates the user, or updates the one `user_id` names. Returns the row's id.
pub async fn write_user(user_id: Option<&str>, username: &str, password: &str) -> anyhow::Result<Option<String>> {
    let mut row = Obj::new();
    row.insert("username".into(), json!(username));
    // An empty password is falsy in the TypeScript: the column is left alone.
    if !password.is_empty() {
        row.insert("password".into(), json!(hash_password(password).await?));
    }
    if let Some(user_id) = user_id.filter(|id| !id.is_empty()) {
        row.insert("user_id".into(), json!(user_id));
    }
    let result = user::TABLE.upsert(&row, None, None).await?;
    Ok(result.and_then(|row| row.get("user_id").and_then(|id| id.as_str()).map(str::to_string)))
}

/// The user with this id and/or name; `None` when neither is given. A user without a password is an error.
pub async fn search_user(user_id: Option<&str>, username: Option<&str>) -> anyhow::Result<Option<User>> {
    let mut filters = Vec::new();
    if let Some(user_id) = user_id.filter(|id| !id.is_empty()) {
        filters.extend(filters! { "user_id" => user_id });
    }
    if let Some(username) = username.filter(|name| !name.is_empty()) {
        filters.extend(filters! { "username" => username });
    }
    if filters.is_empty() {
        return Ok(None);
    }
    user::TABLE.query_one(filters).await?.map(|row| user::to_user(&row)).transpose()
}

/// The user `username` names, if they can sign in with a password: users
/// created by single sign-on have none, and with `exclude_linked` an account
/// linked to the identity provider signs in only through it.
pub async fn search_password_user(username: &str, exclude_linked: bool) -> anyhow::Result<Option<User>> {
    let Some(row) = user::TABLE.query_one(filters! { "username" => username }).await? else { return Ok(None) };
    let has_password = row.get("password").and_then(|p| p.as_str()).map(|p| !p.is_empty()).unwrap_or(false);
    let linked = !row.get("auth_sub").map(|v| v.is_null()).unwrap_or(true);
    if !has_password || (exclude_linked && linked) {
        return Ok(None);
    }
    Ok(Some(user::to_user(&row)?))
}

pub async fn get_user_by_auth_sub(auth_sub: &str) -> anyhow::Result<Option<MaskedUser>> {
    Ok(user::TABLE.query_one(filters! { "auth_sub" => auth_sub }).await?.map(|row| user::to_masked_user(&row)))
}

async fn link_to_auth_sub(model: Option<Row>, auth_sub: &str) -> anyhow::Result<Option<MaskedUser>> {
    let Some(model) = model else { return Ok(None) };
    if !model.get("auth_sub").map(|v| v.is_null()).unwrap_or(true) {
        return Ok(None);
    }
    let mut data = Obj::new();
    data.insert("auth_sub".into(), json!(auth_sub));
    let linked = user::TABLE
        .update(
            model.get("user_id").unwrap_or(&Json::Null),
            &data,
            UpdateArgs {
                returning: Some(&["user_id"]),
                extra_where: &[AdditionalWhere::new("auth_sub", Json::Null)],
                ..Default::default()
            },
        )
        .await?;
    Ok(linked.map(|_| user::to_masked_user(&model)))
}

/// Links the account `username` names to the identity provider's `auth_sub`,
/// unless it is already linked, including by a concurrent sign-in.
pub async fn link_user_to_auth_sub(username: &str, auth_sub: &str) -> anyhow::Result<Option<MaskedUser>> {
    link_to_auth_sub(user::TABLE.query_one(filters! { "username" => username }).await?, auth_sub).await
}

/// Links the account whose email is `email`, in any letter case, unless it is already linked.
pub async fn link_user_by_email(email: &str, auth_sub: &str) -> anyhow::Result<Option<MaskedUser>> {
    let rows = user::TABLE
        .query(
            Vec::new(),
            SearchFilters {
                equals_ignoring_case: Some(("email".to_string(), email.to_string())),
                limit: Some(1),
                ..Default::default()
            },
            None,
        )
        .await?;
    link_to_auth_sub(rows.into_iter().next(), auth_sub).await
}

/// Creates a user with no password for a single sign-on account. `None` when
/// the username, `auth_sub` or email is taken.
pub async fn create_sso_user(username: &str, auth_sub: &str, email: Option<&str>) -> anyhow::Result<Option<MaskedUser>> {
    let mut data = Obj::new();
    data.insert("username".into(), json!(username));
    data.insert("auth_sub".into(), json!(auth_sub));
    if let Some(email) = email {
        data.insert("email".into(), json!(email));
    }
    let row = user::TABLE.insert(&data, Some(&["user_id", "username"]), true).await?;
    Ok(row.map(|row| user::to_masked_user(&row)))
}

pub async fn get_user_by_id(user_id: &str) -> anyhow::Result<Option<User>> {
    user::TABLE.query_one(filters! { "user_id" => user_id }).await?.map(|row| user::to_user(&row)).transpose()
}

pub async fn get_masked_user_by_id(user_id: &str) -> anyhow::Result<Option<MaskedUser>> {
    Ok(user::TABLE.query_one(filters! { "user_id" => user_id }).await?.map(|row| user::to_masked_user(&row)))
}

pub async fn delete_user(user_id: &str) -> anyhow::Result<bool> {
    user::TABLE.soft_delete(&json!(user_id), None).await
}
