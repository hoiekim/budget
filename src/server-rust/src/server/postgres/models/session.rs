//! `src/server/lib/postgres/models/session.ts`.

use serde_json::json;

use super::base::{str_of, Check, IndexDefinition, Row, Table};
use super::user::MaskedUser;
use crate::js::{truthy_opt, Json, JsDate, Obj};
use crate::server::postgres::database::QueryData;

/// What a session started by single sign-on keeps about its sign-in at the identity provider.
#[derive(Clone, Debug)]
pub struct SessionAuth {
    /// The provider's session id (`sid`), which `session.ended` names.
    pub sid: String,
    pub refresh_token: Option<String>,
    /// When the next request must re-check the sign-in with the provider.
    pub recheck_at: JsDate,
}

#[derive(Clone, Debug, Default)]
pub struct SessionCookie {
    pub original_max_age: Option<f64>,
    pub max_age: Option<f64>,
    pub signed: Option<bool>,
    pub expires: Option<JsDate>,
    pub http_only: Option<bool>,
    pub path: Option<String>,
    pub domain: Option<String>,
    pub secure: Option<bool>,
    /// `"lax" | "strict" | "none"`, or a boolean written as `"true"` / `"false"`.
    pub same_site: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SessionData {
    pub user: MaskedUser,
    pub cookie: SessionCookie,
    /// Absent on a session started by the app's own password sign-in.
    pub auth: Option<SessionAuth>,
}

fn is_valid_same_site(value: Option<&Json>) -> bool {
    match value {
        Some(Json::Bool(_)) | Some(Json::Null) => true,
        Some(Json::String(s)) => matches!(s.as_str(), "true" | "false" | "lax" | "strict" | "none"),
        _ => false,
    }
}

pub static TABLE: Table = Table {
    name: "sessions",
    primary_key: "session_id",
    schema: &[
        ("session_id", "VARCHAR(255) PRIMARY KEY"),
        ("user_user_id", "UUID"),
        ("user_username", "VARCHAR(255)"),
        ("cookie_original_max_age", "BIGINT"),
        ("cookie_max_age", "BIGINT"),
        ("cookie_signed", "BOOLEAN"),
        ("cookie_expires", "TIMESTAMPTZ"),
        ("cookie_http_only", "BOOLEAN"),
        ("cookie_path", "TEXT"),
        ("cookie_domain", "TEXT"),
        ("cookie_secure", "BOOLEAN"),
        ("cookie_same_site", "VARCHAR(50)"),
        ("created_at", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("auth_sid", "TEXT"),
        ("auth_refresh_token", "TEXT"),
        ("auth_recheck_at", "TIMESTAMPTZ"),
    ],
    constraints: &[],
    indexes: &[IndexDefinition::column("user_user_id"), IndexDefinition::column("auth_sid")],
    model: "SessionModel",
    checks: &[
        ("session_id", Check::String),
        ("user_user_id", Check::String),
        ("user_username", Check::String),
        ("cookie_original_max_age", Check::NullableNumber),
        ("cookie_max_age", Check::NullableNumber),
        ("cookie_signed", Check::NullableBoolean),
        ("cookie_expires", Check::NullableString),
        ("cookie_http_only", Check::NullableBoolean),
        ("cookie_path", Check::NullableString),
        ("cookie_domain", Check::NullableString),
        ("cookie_secure", Check::NullableBoolean),
        ("cookie_same_site", Check::Custom(is_valid_same_site)),
        ("created_at", Check::NullableString),
        ("updated", Check::NullableString),
        ("auth_sid", Check::NullableString),
        ("auth_refresh_token", Check::NullableString),
        ("auth_recheck_at", Check::NullableString),
    ],
    supports_soft_delete: false,
};

/// `toJSON()`.
pub fn to_session_data(row: &Row) -> SessionData {
    let string_of = |column: &str| row.get(column).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
    let true_of = |column: &str| if truthy_opt(row.get(column)) { Some(true) } else { None };
    let auth = row.get("auth_sid").and_then(|v| v.as_str()).map(|sid| SessionAuth {
        sid: sid.to_string(),
        refresh_token: row.get("auth_refresh_token").and_then(|v| v.as_str()).map(str::to_string),
        recheck_at: match row.get("auth_recheck_at").and_then(|v| v.as_str()) {
            Some(text) => JsDate::parse(text),
            None => JsDate(0.0),
        },
    });
    SessionData {
        user: MaskedUser {
            user_id: str_of(row, "user_user_id").to_string(),
            username: str_of(row, "user_username").to_string(),
        },
        cookie: SessionCookie {
            original_max_age: row.get("cookie_original_max_age").and_then(|v| v.as_f64()),
            max_age: row.get("cookie_max_age").and_then(|v| v.as_f64()).filter(|n| *n != 0.0),
            signed: true_of("cookie_signed"),
            expires: string_of("cookie_expires").map(|text| JsDate::parse(&text)),
            http_only: true_of("cookie_http_only"),
            path: string_of("cookie_path"),
            domain: string_of("cookie_domain"),
            secure: true_of("cookie_secure"),
            same_site: string_of("cookie_same_site"),
        },
        auth,
    }
}

/// `fromSessionAuth()`.
pub fn from_session_auth(auth: &SessionAuth) -> QueryData {
    let mut row = Obj::new();
    row.insert("auth_sid".into(), json!(auth.sid));
    row.insert("auth_refresh_token".into(), json!(auth.refresh_token));
    row.insert("auth_recheck_at".into(), auth.recheck_at.to_json());
    row
}

/// `fromSessionData()`. Leaves the `auth_*` columns out when `data` has no
/// `auth`, so writing it keeps what the row holds.
pub fn from_session_data(sid: &str, data: &SessionData) -> QueryData {
    let number_text = |value: Option<f64>| value.map(|n| json!(crate::js::number_to_string(n))).unwrap_or(Json::Null);
    let mut row = Obj::new();
    row.insert("session_id".into(), json!(sid));
    row.insert("user_user_id".into(), json!(data.user.user_id));
    row.insert("user_username".into(), json!(data.user.username));
    row.insert("cookie_original_max_age".into(), number_text(data.cookie.original_max_age));
    row.insert("cookie_max_age".into(), number_text(data.cookie.max_age));
    row.insert("cookie_signed".into(), json!(data.cookie.signed));
    row.insert("cookie_expires".into(), data.cookie.expires.map(|d| d.to_json()).unwrap_or(Json::Null));
    row.insert("cookie_http_only".into(), json!(data.cookie.http_only));
    row.insert("cookie_path".into(), json!(data.cookie.path));
    row.insert("cookie_domain".into(), json!(data.cookie.domain));
    row.insert("cookie_secure".into(), json!(data.cookie.secure));
    row.insert("cookie_same_site".into(), json!(data.cookie.same_site));
    if let Some(auth) = &data.auth {
        row.extend(from_session_auth(auth));
    }
    row
}
