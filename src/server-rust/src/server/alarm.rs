//! Discord alarms for server errors, under a per-key cooldown and a global
//! per-window ceiling: `src/server/lib/alarm.ts`.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde_json::json;

use crate::js::{js_slice_start, JsDate};
use crate::server::logger;

const COOLDOWN_MS: f64 = 60_000.0;

/// Ceiling on webhook POSTs per cooldown window across all keys.
pub const MAX_SENDS_PER_WINDOW: usize = 10;

/// Slots at the top of the ceiling that only single-shot sources (the crash handlers) may take.
pub const SINGLE_SHOT_RESERVE: usize = 2;

struct State {
    last_alarm_at: HashMap<String, f64>,
    send_timestamps: Vec<f64>,
}

static STATE: LazyLock<Mutex<State>> =
    LazyLock::new(|| Mutex::new(State { last_alarm_at: HashMap::new(), send_timestamps: Vec::new() }));

/// The shared HTTP client for outbound calls. It honours `HTTPS_PROXY` and the
/// system certificate store (`SSL_CERT_FILE`).
pub fn http_client() -> &'static reqwest::Client {
    static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder().build().expect("the HTTP client has valid settings")
    });
    &CLIENT
}

/// Sends a Discord webhook alarm. Never fails: a delivery failure is logged.
///
/// `key` is the cooldown bucket and defaults to `title`. `single_shot` lets a
/// source that fires once and is never retried use the reserved slots.
pub async fn send_alarm(title: &str, detail: &str, key: Option<&str>, single_shot: bool) {
    let Some(webhook_url) = std::env::var("DISCORD_ALARM_WEBHOOK").ok().filter(|url| !url.is_empty()) else {
        return;
    };
    let key = key.unwrap_or(title);
    let now = JsDate::now_ms();
    {
        let mut state = STATE.lock().unwrap();
        let cutoff = now - COOLDOWN_MS;
        state.last_alarm_at.retain(|_, at| *at > cutoff);
        state.send_timestamps.retain(|at| *at > cutoff);

        let last = state.last_alarm_at.get(key).copied().unwrap_or(0.0);
        if now - last < COOLDOWN_MS {
            return;
        }
        let ceiling = if single_shot { MAX_SENDS_PER_WINDOW } else { MAX_SENDS_PER_WINDOW - SINGLE_SHOT_RESERVE };
        if state.send_timestamps.len() >= ceiling {
            logger::warn(
                "Discord alarm dropped — global rate ceiling reached",
                Some(&crate::ctx! {
                    "key": key,
                    "title": title,
                    "lane": if single_shot { "single-shot" } else { "recurring" },
                    "ceiling": ceiling,
                    "windowSends": state.send_timestamps.len(),
                }),
                None,
            );
            return;
        }
        state.last_alarm_at.insert(key.to_string(), now);
        state.send_timestamps.push(now);
    }

    let body = json!({
        "embeds": [{
            "title": format!("🚨 Budget Server Error: {title}"),
            "description": js_slice_start(detail, 4000),
            "color": 0xff0000,
            "timestamp": JsDate::now().to_json(),
        }],
    });
    match http_client().post(&webhook_url).json(&body).send().await {
        Ok(response) if !response.status().is_success() => {
            logger::error(
                "Discord alarm rejected by webhook",
                Some(&crate::ctx! { "key": key, "title": title, "status": response.status().as_u16() }),
                None,
            );
        }
        Ok(_) => {}
        Err(error) => {
            logger::error(
                "Failed to send Discord alarm",
                Some(&crate::ctx! { "key": key, "title": title }),
                Some(&anyhow::Error::new(error)),
            );
        }
    }
}

/// Max time a crash path waits for its alarm to reach Discord before the process exits anyway.
pub const CRASH_ALARM_TIMEOUT: Duration = Duration::from_millis(5_000);

/// The alarm body for a crash: message plus a bounded stack.
pub fn format_crash_detail(message: &str, stack: &str) -> String {
    format!("**Message:** {}\n```\n{}\n```", message, js_slice_start(stack, 1000))
}

/// Sends a crash alarm in the single-shot lane and waits for it, bounded.
pub async fn deliver_crash_alarm(title: &str, message: &str, stack: &str) {
    let detail = format_crash_detail(message, stack);
    let _ = tokio::time::timeout(CRASH_ALARM_TIMEOUT, send_alarm(title, &detail, Some(title), true)).await;
}
