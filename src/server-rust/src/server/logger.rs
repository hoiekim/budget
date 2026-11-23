//! Structured logging, the counterpart of `src/server/lib/logger.ts`: JSON
//! lines in production, colored human-readable lines otherwise, silent below
//! `LOG_LEVEL` (default `info`, or `error` under `NODE_ENV=test`).

use serde_json::json;

use crate::js::{json_stringify, Json, JsDate, Obj};
use crate::server::node_env::{is_production, node_env};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

impl Level {
    fn name(self) -> &'static str {
        match self {
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }

    fn color(self) -> &'static str {
        match self {
            Level::Debug => "\x1b[36m",
            Level::Info => "\x1b[32m",
            Level::Warn => "\x1b[33m",
            Level::Error => "\x1b[31m",
        }
    }
}

const RESET: &str = "\x1b[0m";

fn current_level() -> Level {
    match std::env::var("LOG_LEVEL").ok().map(|v| v.to_lowercase()).as_deref() {
        Some("debug") => Level::Debug,
        Some("info") => Level::Info,
        Some("warn") => Level::Warn,
        Some("error") => Level::Error,
        _ if node_env().as_deref() == Some("test") => Level::Error,
        _ => Level::Info,
    }
}

/// The `name` the TypeScript server's error would carry: the class of the
/// error it throws where this one fails. Anything else is a plain `Error`.
fn error_name(error: &anyhow::Error) -> &'static str {
    use crate::common::queue::QueueWaitTimeoutError;
    use crate::server::auth_client::AuthError;
    use crate::server::plaid::util::PlaidError;
    use crate::server::postgres::client::DbError;
    use crate::server::postgres::models::base::ModelValidationError;
    use crate::server::sso::config::SsoConfigError;
    error
        .chain()
        .find_map(|cause| {
            if cause.is::<PlaidError>() {
                // The Plaid SDK calls through axios.
                Some("AxiosError")
            } else if let Some(db) = cause.downcast_ref::<DbError>() {
                // node-postgres names an error the server reported `error`.
                Some(if db.code.is_some() { "error" } else { "Error" })
            } else if cause.is::<ModelValidationError>() {
                Some("ModelValidationError")
            } else if cause.is::<SsoConfigError>() {
                Some("SsoConfigError")
            } else if cause.is::<QueueWaitTimeoutError>() {
                Some("QueueWaitTimeoutError")
            } else if let Some(auth) = cause.downcast_ref::<AuthError>() {
                Some(match auth {
                    AuthError::InvalidGrant(_) => "InvalidGrant",
                    AuthError::Unavailable(_) => "Unavailable",
                    AuthError::InvalidToken(_) => "InvalidToken",
                    AuthError::Login { .. } => "LoginError",
                    AuthError::Other(_) => "Error",
                })
            } else {
                None
            }
        })
        .unwrap_or("Error")
}

/// Where the error was raised, written like a JS `error.stack`: its name and
/// message, then this crate's frames, innermost first. Only when a backtrace
/// was captured (`main` turns capturing on).
fn stack_of(error: &anyhow::Error) -> Option<String> {
    let backtrace = error.backtrace();
    if backtrace.status() != std::backtrace::BacktraceStatus::Captured {
        return None;
    }
    let frames: Vec<String> = backtrace
        .to_string()
        .lines()
        .filter_map(|line| {
            // `  12: budget_server::server::plaid::institutions::get_institution::{{closure}}`
            let (number, symbol) = line.trim().split_once(": ")?;
            number.parse::<usize>().ok()?;
            symbol.starts_with("budget_server::").then(|| format!("    at {symbol}"))
        })
        .collect();
    if frames.is_empty() {
        return None;
    }
    Some(format!("{}: {:#}\n{}", error_name(error), error, frames.join("\n")))
}

/// `{ message, stack, name }`, as the TypeScript logger writes an `Error`.
fn error_entry(error: &anyhow::Error) -> Json {
    let mut entry = Obj::new();
    entry.insert("message".into(), json!(format!("{error:#}")));
    if let Some(stack) = stack_of(error) {
        entry.insert("stack".into(), json!(stack));
    }
    entry.insert("name".into(), json!(error_name(error)));
    Json::Object(entry)
}

/// Logging context: an object literal, e.g. `ctx!{ "itemId": item_id }`.
pub type Context = Obj;

fn log(level: Level, message: &str, context: Option<&Context>, error: Option<&anyhow::Error>) {
    if level < current_level() {
        return;
    }
    let timestamp = JsDate::now();
    let context = context.filter(|c| !c.is_empty());
    let output = if is_production() {
        let mut entry = Obj::new();
        entry.insert("timestamp".into(), timestamp.to_json());
        entry.insert("level".into(), json!(level.name()));
        entry.insert("message".into(), json!(message));
        if let Some(context) = context {
            entry.insert("context".into(), Json::Object(context.clone()));
        }
        if let Some(error) = error {
            entry.insert("error".into(), error_entry(error));
        }
        json_stringify(&Json::Object(entry))
    } else {
        let mut line = format!(
            "{} {}{:<5}{} {}",
            timestamp.to_locale_time_string(),
            level.color(),
            level.name().to_uppercase(),
            RESET,
            message
        );
        if let Some(context) = context {
            line.push(' ');
            line.push_str(&json_stringify(&Json::Object(context.clone())));
        }
        if let Some(error) = error {
            line.push_str(&format!("\n  {}Error: {:#}{}", Level::Error.color(), error, RESET));
            if current_level() == Level::Debug {
                if let Some(stack) = stack_of(error) {
                    line.push_str(&format!("\n  {stack}"));
                }
            }
        }
        line
    };
    if level >= Level::Warn {
        eprintln!("{output}");
    } else {
        println!("{output}");
    }
}

pub fn debug(message: &str, context: Option<&Context>) {
    log(Level::Debug, message, context, None);
}

pub fn info(message: &str, context: Option<&Context>) {
    log(Level::Info, message, context, None);
}

pub fn warn(message: &str, context: Option<&Context>, error: Option<&anyhow::Error>) {
    log(Level::Warn, message, context, error);
}

pub fn error(message: &str, context: Option<&Context>, error: Option<&anyhow::Error>) {
    log(Level::Error, message, context, error);
}

/// Builds a logging context (or any JSON object) from `"key": value` pairs,
/// in order. Values go through `serde_json::json!`.
///
/// ```ignore
/// logger::info("Synced Plaid item", Some(&ctx! { "itemId": item_id, "accountsUpdated": count }));
/// ```
#[macro_export]
macro_rules! ctx {
    ($($key:literal : $value:expr),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut map = $crate::js::Obj::new();
        $( map.insert($key.to_string(), ::serde_json::json!($value)); )*
        map
    }};
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::plaid::util::PlaidError;
    use crate::server::postgres::client::DbError;

    #[test]
    fn errors_carry_the_name_the_typescript_server_gives_them() {
        let plaid = anyhow::Error::new(PlaidError::from_response(400, json!({}))).context("Failed to get institution data");
        assert_eq!(error_name(&plaid), "AxiosError");
        let reported = anyhow::Error::new(DbError { code: Some("23505".into()), message: "duplicate key".into() });
        assert_eq!(error_name(&reported), "error");
        let unreachable = anyhow::Error::new(DbError { code: None, message: "connection refused".into() });
        assert_eq!(error_name(&unreachable), "Error");
        assert_eq!(error_name(&anyhow::anyhow!("plain")), "Error");
    }

    #[test]
    fn an_error_entry_lists_message_then_stack_then_name() {
        let entry = error_entry(&anyhow::anyhow!("boom"));
        let keys: Vec<&str> = entry.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys.first(), Some(&"message"));
        assert_eq!(keys.last(), Some(&"name"));
        assert_eq!(entry["message"], json!("boom"));
        if let Some(stack) = entry.get("stack") {
            let stack = stack.as_str().unwrap();
            assert!(stack.starts_with("Error: boom\n    at budget_server::"), "{stack}");
        }
    }
}
