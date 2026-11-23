//! `src/server/lib/postgres/repositories/session.ts`.

use std::time::Duration;

use serde_json::json;

use crate::filters;
use crate::js::JsDate;
use crate::server::logger;
use crate::server::postgres::models::session::{self, SessionAuth, SessionData};
use crate::server::postgres::models::UpdateArgs;

/// Removes expired sessions; returns how many.
pub async fn purge_sessions() -> anyhow::Result<u64> {
    session::TABLE.delete_by_condition("cookie_expires", "<=", &JsDate::now().to_json()).await
}

/// Stores a single sign-on session's re-check outcome; `false` when the session is gone.
pub async fn update_session_auth(sid: &str, auth: &SessionAuth) -> anyhow::Result<bool> {
    let updated = session::TABLE.update(&json!(sid), &session::from_session_auth(auth), UpdateArgs::default()).await?;
    Ok(updated.is_some())
}

pub async fn delete_sessions_by_auth_sid(auth_sid: &str) -> anyhow::Result<u64> {
    session::TABLE.hard_delete_by_column("auth_sid", &json!(auth_sid)).await
}

pub async fn delete_sessions_by_user_id(user_id: &str) -> anyhow::Result<u64> {
    session::TABLE.hard_delete_by_column("user_user_id", &json!(user_id)).await
}

pub struct PostgresSessionStore;

impl PostgresSessionStore {
    /// Arms the expiry sweep: a minute after start, then hourly.
    pub fn new() -> Self {
        tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(60)).await;
            loop {
                match purge_sessions().await {
                    Ok(count) if count > 0 => logger::info(
                        &format!("Purged {count} expired session(s)"),
                        Some(&crate::ctx! { "component": "sessions" }),
                    ),
                    Ok(_) => {}
                    Err(error) => {
                        logger::error("Session cleanup error", Some(&crate::ctx! { "component": "sessions" }), Some(&error))
                    }
                }
                tokio::time::sleep(Duration::from_secs(60 * 60)).await;
            }
        });
        PostgresSessionStore
    }

    pub async fn get(&self, sid: &str) -> anyhow::Result<Option<SessionData>> {
        let Some(row) = session::TABLE.query_one(filters! { "session_id" => sid }).await? else { return Ok(None) };
        // Expiry is enforced here, at the point of use, not just in the sweep.
        // An unparseable value fails closed.
        if let Some(expires) = row.get("cookie_expires").and_then(|v| v.as_str()) {
            let expires_at = JsDate::parse(expires).get_time();
            // NaN compares false, which fails closed like `!(expiresAt > Date.now())`.
            let live = expires_at > JsDate::now_ms();
            if !live {
                let _ = session::TABLE.hard_delete(&json!(sid)).await;
                return Ok(None);
            }
        }
        Ok(Some(session::to_session_data(&row)))
    }

    pub async fn set(&self, sid: &str, data: &SessionData) -> anyhow::Result<()> {
        let row = session::from_session_data(sid, data);
        let columns: Vec<&str> = row.keys().map(|k| k.as_str()).filter(|k| *k != "session_id").collect();
        session::TABLE.upsert(&row, Some(&columns), None, None).await?;
        Ok(())
    }

    pub async fn destroy(&self, sid: &str) -> anyhow::Result<()> {
        session::TABLE.hard_delete(&json!(sid)).await?;
        Ok(())
    }

    /// Like `set`, but an UPDATE: a row deleted meanwhile stays deleted.
    pub async fn touch(&self, sid: &str, data: &SessionData) -> anyhow::Result<()> {
        let mut row = session::from_session_data(sid, data);
        row.shift_remove("session_id");
        session::TABLE.update(&json!(sid), &row, UpdateArgs::default()).await?;
        Ok(())
    }
}

impl Default for PostgresSessionStore {
    fn default() -> Self {
        Self::new()
    }
}
