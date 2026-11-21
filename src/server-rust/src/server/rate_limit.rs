//! In-memory rate limiters and the client-address resolution they key on;
//! `src/server/lib/rate-limit.ts`.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use crate::js::JsDate;

/// The caller's address: `X-Real-IP`, else the first `X-Forwarded-For` entry, else the socket's.
pub fn get_client_ip(headers: &HashMap<String, String>, socket_ip: Option<&str>) -> String {
    if let Some(real) = headers.get("x-real-ip") {
        return real.clone();
    }
    if let Some(forwarded) = headers.get("x-forwarded-for") {
        // `"".split(",")[0]?.trim()` is `""`, which `??` keeps.
        return forwarded.split(',').next().map(|first| first.trim().to_string()).unwrap_or_default();
    }
    socket_ip.map(str::to_string).unwrap_or_else(|| "unknown".to_string())
}

struct Record {
    count: i64,
    reset_at: f64,
}

/// One record per (bucket, key). Buckets share this map and its cleanup but never counters.
static ATTEMPTS: LazyLock<Mutex<HashMap<String, Record>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

const CLEANUP_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// Starts the hourly sweep of expired records. Call once, from the start-up path.
pub fn start_rate_limit_cleanup() {
    tokio::spawn(async {
        let mut ticker = tokio::time::interval(CLEANUP_INTERVAL);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let now = JsDate::now_ms();
            ATTEMPTS.lock().unwrap().retain(|_, record| now < record.reset_at);
        }
    });
}

pub struct RateLimiter {
    bucket: &'static str,
    max_attempts: i64,
    window_ms: f64,
}

impl RateLimiter {
    pub const fn new(bucket: &'static str, max_attempts: i64, window_ms: f64) -> Self {
        RateLimiter { bucket, max_attempts, window_ms }
    }

    fn key(&self, subject: &str) -> String {
        format!("{}:{}", self.bucket, subject)
    }

    /// True once the subject has consumed `max_attempts` slots in the active window. Read-only.
    pub fn is_limited(&self, subject: &str) -> bool {
        let attempts = ATTEMPTS.lock().unwrap();
        match attempts.get(&self.key(subject)) {
            Some(record) => JsDate::now_ms() < record.reset_at && record.count >= self.max_attempts,
            None => false,
        }
    }

    /// Slots left in the active window, or the full quota once it has expired.
    pub fn remaining(&self, subject: &str) -> i64 {
        let attempts = ATTEMPTS.lock().unwrap();
        match attempts.get(&self.key(subject)) {
            Some(record) if JsDate::now_ms() < record.reset_at => (self.max_attempts - record.count).max(0),
            _ => self.max_attempts,
        }
    }

    pub fn consume(&self, subject: &str, slots: i64) {
        let now = JsDate::now_ms();
        let mut attempts = ATTEMPTS.lock().unwrap();
        match attempts.get_mut(&self.key(subject)) {
            Some(record) if now < record.reset_at => record.count += slots,
            _ => {
                attempts.insert(self.key(subject), Record { count: slots, reset_at: now + self.window_ms });
            }
        }
    }

    /// Gives back slots consumed in the active window, never below zero.
    pub fn refund(&self, subject: &str, slots: i64) {
        let mut attempts = ATTEMPTS.lock().unwrap();
        if let Some(record) = attempts.get_mut(&self.key(subject)) {
            if JsDate::now_ms() < record.reset_at {
                record.count = (record.count - slots).max(0);
            }
        }
    }

    pub fn reset(&self, subject: &str) {
        ATTEMPTS.lock().unwrap().remove(&self.key(subject));
    }
}

const MINUTE: f64 = 60.0 * 1000.0;

pub static LOGIN_RATE_LIMITER: RateLimiter = RateLimiter::new("login", 5, 15.0 * MINUTE);

/// Kept under the alarm cooldown's own ceiling.
pub static CLIENT_ERROR_RATE_LIMITER: RateLimiter = RateLimiter::new("client-error", 12, 15.0 * MINUTE);

/// Keyed by user id: one bucket for every route that can reach the Polygon gate on caller-supplied input.
pub static POLYGON_LOOKUP_RATE_LIMITER: RateLimiter = RateLimiter::new("polygon-lookup", 10, MINUTE);

pub const POLYGON_LOOKUP_SHED_MESSAGE: &str = "Too many ticker lookups, try again in a minute.";

/// Keyed by user id; the unit charged is the Plaid round trip.
pub static INSTITUTION_FALLBACK_RATE_LIMITER: RateLimiter = RateLimiter::new("institution-fallback", 20, MINUTE);

/// One bucket for the whole process: it protects the production Plaid credential's quota.
pub static PLAID_KEY_FETCH_RATE_LIMITER: RateLimiter = RateLimiter::new("plaid-key-fetch", 10, MINUTE);

/// Keyed by item id.
pub static PLAID_ITEM_KEY_FETCH_RATE_LIMITER: RateLimiter = RateLimiter::new("plaid-item-key-fetch", 6, 60.0 * MINUTE);

struct PreSessionLimit {
    method: &'static str,
    path: &'static str,
    limiter: &'static RateLimiter,
    message: &'static str,
}

static PRE_SESSION_RATE_LIMITS: [PreSessionLimit; 2] = [
    PreSessionLimit {
        method: "POST",
        path: "/login",
        limiter: &LOGIN_RATE_LIMITER,
        message: "Too many login attempts, try again later",
    },
    PreSessionLimit {
        method: "POST",
        path: "/client-error",
        limiter: &CLIENT_ERROR_RATE_LIMITER,
        message: "Too many client error reports, try again later",
    },
];

/// The message to shed a request with, or `None` to let it through. Read-only:
/// the route charges the slot.
pub fn pre_session_shed_message(method: &str, path: &str, ip: &str) -> Option<&'static str> {
    PRE_SESSION_RATE_LIMITS
        .iter()
        .find(|entry| entry.method == method && entry.path == path)
        .filter(|entry| entry.limiter.is_limited(ip))
        .map(|entry| entry.message)
}
