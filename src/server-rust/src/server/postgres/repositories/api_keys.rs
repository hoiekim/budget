//! `src/server/lib/postgres/repositories/api_keys.ts`.

use base64::Engine;
use rand::RngCore;
use serde_json::json;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::filters;
use crate::js::{Json, JsDate, Obj};
use crate::server::postgres::client::{pool, Executor};
use crate::server::postgres::database::AdditionalWhere;
use crate::server::postgres::models::api_key;
use crate::server::postgres::models::UpdateArgs;

const KEY_PLAINTEXT_PREFIX: &str = "bk_";

pub struct GeneratedApiKey {
    pub plaintext: String,
    pub hash: String,
    pub prefix: String,
}

/// A new API key: `bk_` and 43 base64url characters from 32 random bytes.
/// Only its SHA-256 is stored.
pub fn generate_api_key() -> GeneratedApiKey {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let random = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let plaintext = format!("{KEY_PLAINTEXT_PREFIX}{random}");
    let hash = hash_api_key(&plaintext);
    let prefix = plaintext.chars().take(11).collect();
    GeneratedApiKey { plaintext, hash, prefix }
}

pub fn hash_api_key(plaintext: &str) -> String {
    hex::encode(Sha256::digest(plaintext.as_bytes()))
}

pub struct CreatedApiKey {
    pub key_id: String,
    pub plaintext: String,
    pub prefix: String,
}

pub async fn create_api_key(user_id: &str, name: &str, scopes: &[String], expires_at: Option<&str>) -> anyhow::Result<CreatedApiKey> {
    let generated = generate_api_key();
    let mut data = Obj::new();
    data.insert("user_id".into(), json!(user_id));
    data.insert("name".into(), json!(name));
    data.insert("key_hash".into(), json!(generated.hash));
    data.insert("key_prefix".into(), json!(generated.prefix));
    data.insert("scopes".into(), json!(scopes));
    data.insert("expires_at".into(), json!(expires_at));
    let result = api_key::TABLE.insert(&data, Some(&["key_id"]), false).await?;
    let key_id = result
        .and_then(|row| row.get("key_id").and_then(|id| id.as_str()).map(str::to_string))
        .ok_or_else(|| anyhow::anyhow!("Failed to create API key"))?;
    Ok(CreatedApiKey { key_id, plaintext: generated.plaintext, prefix: generated.prefix })
}

/// The user's keys that are not revoked, newest first, without their hashes.
pub async fn list_api_keys(user_id: &str) -> anyhow::Result<Vec<Json>> {
    let sql = "
    SELECT key_id, user_id, name, key_prefix, scopes,
           created_at, last_used_at, revoked_at, expires_at
    FROM api_keys
    WHERE user_id = $1 AND revoked_at IS NULL
    ORDER BY created_at DESC
  ";
    let result = pool().query(sql, &[json!(user_id)]).await?;
    result
        .rows
        .into_iter()
        .map(|mut row| {
            // The hash is deliberately not selected; the model still checks the visible fields.
            row.insert("key_hash".into(), json!(""));
            row.insert("updated".into(), Json::Null);
            Ok(api_key::to_json(&api_key::TABLE.validate(row)?))
        })
        .collect()
}

/// Revokes a key the user owns; `false` when there is no such live key.
pub async fn revoke_api_key(key_id: &str, user_id: &str) -> anyhow::Result<bool> {
    let mut data = Obj::new();
    data.insert("revoked_at".into(), JsDate::now().to_json());
    let updated = api_key::TABLE
        .update(
            &json!(key_id),
            &data,
            UpdateArgs {
                returning: Some(&["key_id"]),
                user_id: Some(user_id),
                extra_where: &[AdditionalWhere::new("revoked_at", Json::Null)],
                ..Default::default()
            },
        )
        .await?;
    Ok(updated.is_some())
}

pub struct ResolvedApiKey {
    pub key_id: String,
    pub user_id: String,
    pub scopes: Vec<String>,
}

/// Looks an API key up by its plaintext. `None` when it is unknown, revoked or expired.
pub async fn verify_api_key(plaintext: &str) -> anyhow::Result<Option<ResolvedApiKey>> {
    if !plaintext.starts_with(KEY_PLAINTEXT_PREFIX) {
        return Ok(None);
    }
    let hash = hash_api_key(plaintext);
    let Some(row) = api_key::TABLE.query_one(filters! { "key_hash" => hash.clone() }).await? else { return Ok(None) };
    let text = |column: &str| row.get(column).and_then(|v| v.as_str()).unwrap_or("").to_string();

    // Constant-time compare on top of the indexed lookup, as defense in depth.
    let expected = hex::decode(text("key_hash")).unwrap_or_default();
    let actual = hex::decode(&hash).unwrap_or_default();
    if expected.len() != actual.len() || !bool::from(expected.ct_eq(&actual)) {
        return Ok(None);
    }
    if !text("revoked_at").is_empty() {
        return Ok(None);
    }
    let expires_at = text("expires_at");
    if !expires_at.is_empty() && JsDate::parse(&expires_at).get_time() < JsDate::now_ms() {
        return Ok(None);
    }

    // Best-effort touch; a failure here must not block the request.
    let key_id = text("key_id");
    let touched = key_id.clone();
    tokio::spawn(async move {
        let mut data = Obj::new();
        data.insert("last_used_at".into(), JsDate::now().to_json());
        let _ = api_key::TABLE.update(&json!(touched), &data, UpdateArgs::default()).await;
    });

    let scopes = row
        .get("scopes")
        .and_then(|v| v.as_array())
        .map(|items| items.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    Ok(Some(ResolvedApiKey { key_id, user_id: text("user_id"), scopes }))
}
