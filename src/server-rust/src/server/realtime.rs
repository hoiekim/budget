//! Per-user server-sent-event subscribers and the replay buffer behind
//! `GET /events`: `src/server/lib/realtime.ts`.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use serde_json::json;

use crate::js::{parse_int, Json, JsDate, Obj};

/// Gap between `: keepalive` blocks on an otherwise-quiet stream.
pub const SSE_KEEPALIVE_MS: u64 = 30_000;

pub const RING_BUFFER_MAX_ENTRIES: usize = 512;
pub const RING_BUFFER_MAX_AGE_MS: f64 = 15.0 * 60.0 * 1000.0;

/// One open event stream.
pub struct Subscriber {
    /// Writes one `event:`/`data:` block; an error means the stream is gone.
    pub send: Box<dyn Fn(&str, &Json, Option<&str>) -> Result<(), ()> + Send + Sync>,
    /// Ends the stream and releases what it holds.
    pub close: Box<dyn Fn() + Send + Sync>,
    /// The identity provider's session id, on a stream opened by a single sign-on session.
    pub auth_sid: Option<String>,
}

#[derive(Clone)]
pub struct StoredEvent {
    /// Monotonic per-user counter, shared by all of a user's tabs.
    pub id: String,
    /// The table the write touched.
    pub domain: String,
    pub payload: Json,
    pub timestamp: f64,
}

struct Registry {
    subscribers: HashMap<String, Vec<Arc<Subscriber>>>,
    buffers: HashMap<String, Vec<StoredEvent>>,
    counters: HashMap<String, f64>,
    /// Every user's ids start here: the process's boot time, so an id from
    /// before a restart reads as a gap.
    counter_base: f64,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| {
    Mutex::new(Registry {
        subscribers: HashMap::new(),
        buffers: HashMap::new(),
        counters: HashMap::new(),
        counter_base: JsDate::now_ms(),
    })
});

/// Fixes the id base at start-up rather than at the first event.
pub fn initialize() {
    drop(REGISTRY.lock().unwrap());
}

pub struct EventsSince {
    pub events: Vec<StoredEvent>,
    /// The buffer does not cover the gap: the client must refetch everything.
    pub overflow: bool,
}

/// The events a reconnecting client asked for, or the signal to resync.
pub fn get_events_since(user_id: &str, last_event_id: Option<&str>) -> EventsSince {
    let registry = REGISTRY.lock().unwrap();
    let buffer = registry.buffers.get(user_id);
    let counter_tip = registry.counters.get(user_id).copied().unwrap_or(registry.counter_base);
    let none = |overflow: bool| EventsSince { events: Vec::new(), overflow };
    let Some(last_event_id) = last_event_id else {
        return none(buffer.map(|b| !b.is_empty()).unwrap_or(false));
    };
    let Some(last_id) = parse_int(last_event_id) else { return none(true) };
    if last_id > counter_tip {
        return none(true);
    }
    if last_id == counter_tip {
        return none(false);
    }
    let Some(buffer) = buffer.filter(|b| !b.is_empty()) else { return none(true) };
    let id_of = |event: &StoredEvent| parse_int(&event.id).unwrap_or(f64::NAN);
    if id_of(&buffer[0]) > last_id + 1.0 {
        return none(true);
    }
    EventsSince { events: buffer.iter().filter(|e| id_of(e) > last_id).cloned().collect(), overflow: false }
}

/// The id of the user's most recent event, or the counter base before the first.
pub fn current_event_id(user_id: &str) -> String {
    let registry = REGISTRY.lock().unwrap();
    crate::js::number_to_string(registry.counters.get(user_id).copied().unwrap_or(registry.counter_base))
}

const MUTATION_DOMAINS: [(&str, &str); 24] = [
    ("/transaction", "transactions"),
    ("/new-transaction", "transactions"),
    ("/suggest-category", "transactions"),
    ("/split-transaction", "split_transactions"),
    ("/new-split-transaction", "split_transactions"),
    ("/investment-transaction", "investment_transactions"),
    ("/new-investment-transaction", "investment_transactions"),
    ("/plan-statement/import", "investment_transactions"),
    ("/account", "accounts"),
    ("/public-token", "accounts"),
    ("/item", "accounts"),
    ("/snapshot", "snapshots"),
    ("/snapshots/holding", "snapshots"),
    ("/budget", "budgets"),
    ("/new-budget", "budgets"),
    ("/section", "sections"),
    ("/new-section", "sections"),
    ("/category", "categories"),
    ("/new-category", "categories"),
    ("/chart", "charts"),
    ("/new-chart", "charts"),
    ("/transfers/pair", "transaction_pairs"),
    ("/transfers", "transaction_pairs"),
    ("/recurrings", "recurrings"),
];

/// The table a request mutates, or `None` if it isn't a domain write. A path
/// emits only under a mutating verb: POST, DELETE, or a `/new-*` insert a GET performs.
pub fn mutation_emit_domain(method: &str, path: &str) -> Option<&'static str> {
    let mutating = method == "POST" || method == "DELETE" || path.starts_with("/new-");
    if !mutating {
        return None;
    }
    MUTATION_DOMAINS.iter().find(|(p, _)| *p == path).map(|(_, domain)| *domain)
}

/// Tables a path's write also changes as a side effect. These are emitted
/// without the writing tab's id, so every tab refetches them.
pub fn mutation_side_effect_domains(method: &str, path: &str) -> &'static [&'static str] {
    if mutation_emit_domain(method, path).is_none() {
        return &[];
    }
    match path {
        "/plan-statement/import" => &["accounts", "snapshots"],
        "/recurrings" => &["transactions", "split_transactions"],
        _ => &[],
    }
}

/// The tab a request came from, from its `X-Tab-Id`, so that tab can
/// recognise the event as its own. An empty header names no tab.
pub fn origin_tab_payload(headers: &std::collections::HashMap<String, String>) -> Option<String> {
    headers.get("x-tab-id").filter(|tab| !tab.is_empty()).cloned()
}

/// [`emit_to_user`] for a user and everyone sharing data with them: what one
/// of them writes, all of them see. Finding the group is a query, so a caller
/// on a response path spawns this rather than awaiting it. It never fails:
/// when the group can't be read, the user alone is told.
pub async fn emit_to_sharing_group(user_id: &str, domain: &str, origin_tab_id: Option<&str>) {
    let user_ids = match crate::server::postgres::repositories::sharing::get_sharing_user_ids(user_id, None).await {
        Ok(user_ids) => user_ids,
        Err(error) => {
            crate::server::logger::warn(
                "Sharing group lookup failed; the event reaches its author only",
                Some(&crate::ctx! { "userId": user_id, "domain": domain }),
                Some(&error),
            );
            vec![user_id.to_string()]
        }
    };
    for id in user_ids {
        emit_to_user(&id, domain, origin_tab_id);
    }
}

/// Spawns [`emit_to_sharing_group`], the TypeScript's `void emitToSharingGroup(…)`.
pub fn spawn_emit_to_sharing_group(user_id: &str, domain: &str, origin_tab_id: Option<String>) {
    let (user_id, domain) = (user_id.to_string(), domain.to_string());
    tokio::spawn(async move { emit_to_sharing_group(&user_id, &domain, origin_tab_id.as_deref()).await });
}

pub fn register_subscriber(user_id: &str, subscriber: Arc<Subscriber>) {
    REGISTRY.lock().unwrap().subscribers.entry(user_id.to_string()).or_default().push(subscriber);
}

pub fn unregister_subscriber(user_id: &str, subscriber: &Arc<Subscriber>) {
    let mut registry = REGISTRY.lock().unwrap();
    if let Some(list) = registry.subscribers.get_mut(user_id) {
        list.retain(|candidate| !Arc::ptr_eq(candidate, subscriber));
        // The buffer and counter survive the last subscriber, so a reconnect can still replay.
        if list.is_empty() {
            registry.subscribers.remove(user_id);
        }
    }
}

pub fn subscriber_count(user_id: &str) -> usize {
    REGISTRY.lock().unwrap().subscribers.get(user_id).map(|list| list.len()).unwrap_or(0)
}

/// Buffers a `<domain>-updated` event for the user and sends it to every open tab.
/// `origin_tab_id` is the writing tab's `X-Tab-Id`, echoed so it can skip its own event.
pub fn emit_to_user(user_id: &str, domain: &str, origin_tab_id: Option<&str>) {
    let mut payload = Obj::new();
    if let Some(tab) = origin_tab_id {
        payload.insert("originTabId".into(), json!(tab));
    }
    let payload = Json::Object(payload);
    let (id, targets) = {
        let mut registry = REGISTRY.lock().unwrap();
        let base = registry.counter_base;
        let next = registry.counters.get(user_id).copied().unwrap_or(base) + 1.0;
        registry.counters.insert(user_id.to_string(), next);
        let id = crate::js::number_to_string(next);
        let now = JsDate::now_ms();
        let buffer = registry.buffers.entry(user_id.to_string()).or_default();
        buffer.push(StoredEvent { id: id.clone(), domain: domain.to_string(), payload: payload.clone(), timestamp: now });
        let cutoff = now - RING_BUFFER_MAX_AGE_MS;
        while !buffer.is_empty() && (buffer.len() > RING_BUFFER_MAX_ENTRIES || buffer[0].timestamp < cutoff) {
            buffer.remove(0);
        }
        (id, registry.subscribers.get(user_id).cloned().unwrap_or_default())
    };
    let event_name = format!("{domain}-updated");
    for subscriber in targets {
        if (subscriber.send)(&event_name, &payload, Some(&id)).is_err() {
            crate::server::logger::warn(
                "SSE subscriber send failed — dropping",
                Some(&crate::ctx! { "userId": user_id, "domain": domain }),
                None,
            );
            (subscriber.close)();
        }
    }
}

/// Which connections [`close_subscribers`] closes.
pub enum Which<'a> {
    UserId(&'a str),
    AuthSid(&'a str),
}

/// Closes this process's connections of a user whose access ended, or of one single sign-on session.
pub fn close_subscribers(which: Which<'_>) {
    let targets: Vec<(String, Arc<Subscriber>)> = {
        let registry = REGISTRY.lock().unwrap();
        registry
            .subscribers
            .iter()
            .filter(|(user_id, _)| match which {
                Which::UserId(id) => user_id.as_str() == id,
                Which::AuthSid(_) => true,
            })
            .flat_map(|(user_id, list)| list.iter().map(move |sub| (user_id.clone(), sub.clone())))
            .filter(|(_, sub)| match which {
                Which::UserId(_) => true,
                Which::AuthSid(sid) => sub.auth_sid.as_deref() == Some(sid),
            })
            .collect()
    };
    for (user_id, subscriber) in targets {
        (subscriber.close)();
        unregister_subscriber(&user_id, &subscriber);
    }
}

/// Closes every open subscription, for shutdown.
pub fn close_all_subscribers() {
    let all: Vec<Arc<Subscriber>> = {
        let mut registry = REGISTRY.lock().unwrap();
        registry.subscribers.drain().flat_map(|(_, list)| list).collect()
    };
    for subscriber in all {
        (subscriber.close)();
    }
}
