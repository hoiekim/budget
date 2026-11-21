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
            entry.insert("error".into(), json!({ "message": format!("{error:#}"), "name": "Error" }));
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
