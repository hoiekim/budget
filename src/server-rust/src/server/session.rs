//! Session cookies, the stored session and its single sign-on re-check:
//! `src/server/lib/session.ts`.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;

use futures::future::{BoxFuture, FutureExt, Shared};
use indexmap::IndexMap;

use crate::js::{decode_uri_component, encode_uri_component, truthy_opt, JsDate};
use crate::server::auth_client::AuthError;
use crate::server::logger;
use crate::server::postgres::models::session::{SessionAuth, SessionCookie, SessionData};
use crate::server::postgres::models::MaskedUser;
use crate::server::postgres::repositories::session::{update_session_auth, PostgresSessionStore};
use crate::server::sso::{get_sso, Sso};

pub const SESSION_COOKIE_NAME: &str = "session_id";
pub const SESSION_MAX_AGE_S: i64 = 60 * 60 * 24 * 7;
const SESSION_MAX_AGE_MS: f64 = (SESSION_MAX_AGE_S * 1000) as f64;

/// How long a single sign-on session is served before it is re-checked with the identity provider.
pub const SSO_RECHECK_INTERVAL_MS: f64 = 10.0 * 60.0 * 1000.0;
/// How long past its re-check a session is still served while the identity provider is unreachable.
pub const SSO_MAX_STALENESS_MS: f64 = 60.0 * 60.0 * 1000.0;
/// How often an open event stream re-reads its session.
pub const SESSION_WATCH_INTERVAL: Duration = Duration::from_secs(60);

static STORE: OnceLock<PostgresSessionStore> = OnceLock::new();

/// Built on first use: constructing the store arms its hourly expiry sweep.
pub fn session_store() -> &'static PostgresSessionStore {
    STORE.get_or_init(PostgresSessionStore::new)
}

/// The cookies of a `Cookie` header. `Err` where `decodeURIComponent` would throw.
pub fn parse_cookies(cookie_header: &str) -> Result<IndexMap<String, String>, ()> {
    let mut cookies = IndexMap::new();
    for part in cookie_header.split(';') {
        let Some(eq) = part.find('=') else { continue };
        let key = crate::server::validation::js_trim(&part[..eq]);
        let value = crate::server::validation::js_trim(&part[eq + 1..]);
        if !key.is_empty() {
            cookies.insert(key.to_string(), decode_uri_component(value).ok_or(())?);
        }
    }
    Ok(cookies)
}

pub fn build_session_cookie(sid: &str, max_age: i64, secure: bool) -> String {
    let mut parts = vec![
        format!("{}={}", SESSION_COOKIE_NAME, encode_uri_component(sid)),
        format!("Max-Age={max_age}"),
        "Path=/".to_string(),
        "HttpOnly".to_string(),
        "SameSite=Strict".to_string(),
    ];
    if secure {
        parts.push("Secure".to_string());
    }
    parts.join("; ")
}

/// A session's row as of now: a fresh expiry, and `auth` only when the caller is starting the session.
pub fn build_session_data(user: &MaskedUser, secure: bool, auth: Option<SessionAuth>) -> SessionData {
    SessionData {
        user: user.clone(),
        cookie: SessionCookie {
            original_max_age: Some(SESSION_MAX_AGE_MS),
            max_age: Some(SESSION_MAX_AGE_MS),
            signed: None,
            expires: Some(JsDate::from_ms(JsDate::now_ms() + SESSION_MAX_AGE_MS)),
            http_only: Some(true),
            path: Some("/".to_string()),
            domain: None,
            secure: Some(secure),
            same_site: Some("strict".to_string()),
        },
        auth,
    }
}

/// Writes a signed-in session's row with a fresh expiry. `stored` says the row
/// was read on this request: with single sign-on on, it is then updated rather
/// than upserted, so a session an event deleted mid-request stays deleted.
pub async fn save_session(sid: &str, user: &MaskedUser, secure: bool, stored: bool) -> anyhow::Result<()> {
    let data = build_session_data(user, secure, None);
    if stored && get_sso().is_some() {
        session_store().touch(sid, &data).await
    } else {
        session_store().set(sid, &data).await
    }
}

async fn end_session(sid: &str) -> anyhow::Result<Option<SessionData>> {
    session_store().destroy(sid).await?;
    Ok(None)
}

async fn recheck(sid: String, data: SessionData, auth: SessionAuth, sso: Arc<Sso>) -> anyhow::Result<Option<SessionData>> {
    let Some(refresh_token) = auth.refresh_token.clone() else { return end_session(&sid).await };
    let refreshed = match sso.client.refresh(&refresh_token).await {
        Ok(refreshed) => refreshed,
        Err(AuthError::InvalidGrant(_)) => return end_session(&sid).await,
        Err(error) => {
            let context = crate::ctx! { "component": "sso" };
            let unavailable = matches!(error, AuthError::Unavailable(_));
            let error = anyhow::Error::new(error);
            if unavailable {
                logger::warn("Single sign-on re-check could not reach the identity provider", Some(&context), Some(&error));
            } else {
                logger::error("Single sign-on re-check failed", Some(&context), Some(&error));
            }
            if JsDate::now_ms() > auth.recheck_at.get_time() + SSO_MAX_STALENESS_MS {
                return end_session(&sid).await;
            }
            return Ok(Some(data));
        }
    };
    // Budget has no roles of its own: any role is access.
    if !truthy_opt(refreshed.claims.get("role")) {
        return end_session(&sid).await;
    }
    let next = SessionAuth {
        sid: auth.sid.clone(),
        refresh_token: refreshed.refresh_token.or(auth.refresh_token),
        recheck_at: JsDate::from_ms(JsDate::now_ms() + SSO_RECHECK_INTERVAL_MS),
    };
    if update_session_auth(&sid, &next).await? {
        Ok(Some(SessionData { auth: Some(next), ..data }))
    } else {
        Ok(None)
    }
}

type SharedRecheck = Shared<BoxFuture<'static, Result<Option<SessionData>, Arc<anyhow::Error>>>>;

static RECHECKS: LazyLock<Mutex<HashMap<String, SharedRecheck>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// The session as it may be served now, or `None` once it has ended, in which
/// case its row is deleted. Only a single sign-on session whose re-check is
/// due costs anything beyond the row already read: one refresh with the
/// identity provider, shared by the session's concurrent requests.
pub async fn recheck_session(sid: &str, data: SessionData) -> anyhow::Result<Option<SessionData>> {
    let sso = get_sso();
    let Some(auth) = data.auth.clone() else {
        // A password session ends while single sign-on is the only way in.
        return match &sso {
            Some(sso) if !sso.config.local_login => end_session(sid).await,
            _ => Ok(Some(data)),
        };
    };
    let Some(sso) = sso else { return end_session(sid).await };
    if auth.recheck_at.get_time() > JsDate::now_ms() {
        return Ok(Some(data));
    }
    let pending = {
        let mut rechecks = RECHECKS.lock().unwrap();
        match rechecks.get(sid) {
            Some(pending) => pending.clone(),
            None => {
                let owned_sid = sid.to_string();
                let pending: SharedRecheck = async move {
                    let result = recheck(owned_sid.clone(), data, auth, sso).await.map_err(Arc::new);
                    RECHECKS.lock().unwrap().remove(&owned_sid);
                    result
                }
                .boxed()
                .shared();
                rechecks.insert(sid.to_string(), pending.clone());
                pending
            }
        }
    };
    pending.await.map_err(|error| anyhow::anyhow!("{error:#}"))
}

/// The stored session `sid` names, re-checked; `None` when there is none to serve.
pub async fn load_session_data(sid: &str) -> anyhow::Result<Option<SessionData>> {
    match session_store().get(sid).await? {
        Some(data) => recheck_session(sid, data).await,
        None => Ok(None),
    }
}

/// Calls `on_ended` once the session `sid` names is gone, read every
/// `interval`. A failed read leaves the connection open until a later one
/// succeeds. Dropping (or aborting) the returned task stops watching.
pub fn watch_session(sid: String, on_ended: impl Fn() + Send + Sync + 'static, interval: Duration) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(interval).await;
            match load_session_data(&sid).await {
                Ok(None) => {
                    on_ended();
                    return;
                }
                Ok(Some(_)) => {}
                Err(error) => logger::warn(
                    "Session re-read failed; the stream stays open",
                    Some(&crate::ctx! { "component": "sessions" }),
                    Some(&error),
                ),
            }
        }
    })
}
