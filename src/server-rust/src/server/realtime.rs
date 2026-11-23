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

/// Writes one `event:`/`data:` block (event name, data, event id); an error
/// means the stream is gone.
pub type SendEvent = Box<dyn Fn(&str, &Json, Option<&str>) -> Result<(), ()> + Send + Sync>;

/// One open event stream.
pub struct Subscriber {
    pub send: SendEvent,
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

struct GroupEmit {
    user_id: String,
    domain: String,
    origin_tab_id: Option<String>,
}

/// One task sends every group-wide event, in the order the writes asked for
/// them. Each needs a query to find the group; run as separate tasks, two
/// quick writes could reach a tab in the opposite order, and their event ids
/// with them.
fn group_emitter() -> &'static tokio::sync::mpsc::UnboundedSender<GroupEmit> {
    static EMITTER: std::sync::OnceLock<tokio::sync::mpsc::UnboundedSender<GroupEmit>> = std::sync::OnceLock::new();
    EMITTER.get_or_init(|| {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<GroupEmit>();
        tokio::spawn(async move {
            while let Some(emit) = receiver.recv().await {
                emit_to_sharing_group(&emit.user_id, &emit.domain, emit.origin_tab_id.as_deref()).await;
            }
        });
        sender
    })
}

/// [`emit_to_sharing_group`] off the response path, the TypeScript's
/// `void emitToSharingGroup(…)`: queued, and sent after the events queued before it.
pub fn spawn_emit_to_sharing_group(user_id: &str, domain: &str, origin_tab_id: Option<String>) {
    let _ = group_emitter().send(GroupEmit { user_id: user_id.to_string(), domain: domain.to_string(), origin_tab_id });
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::MutexGuard;

    use super::*;

    /// The registry is one for the process, and `close_all_subscribers` spares
    /// nobody: the tests here take turns.
    static TURN: Mutex<()> = Mutex::new(());

    fn turn() -> MutexGuard<'static, ()> {
        TURN.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    static USERS: AtomicUsize = AtomicUsize::new(0);

    /// A user id no other test uses.
    fn user() -> String {
        format!("realtime-test-user-{}", USERS.fetch_add(1, Ordering::SeqCst))
    }

    /// What a subscriber was sent, and whether it was closed.
    #[derive(Default)]
    struct Recorder {
        sent: Mutex<Vec<(String, Json, Option<String>)>>,
        closed: AtomicBool,
    }

    fn subscriber(recorder: &Arc<Recorder>, auth_sid: Option<&str>, fail_on_send: bool) -> Arc<Subscriber> {
        let (sending, closing) = (recorder.clone(), recorder.clone());
        Arc::new(Subscriber {
            send: Box::new(move |event, payload, id| {
                if fail_on_send {
                    return Err(());
                }
                sending.sent.lock().unwrap().push((event.to_string(), payload.clone(), id.map(str::to_string)));
                Ok(())
            }),
            close: Box::new(move || closing.closed.store(true, Ordering::SeqCst)),
            auth_sid: auth_sid.map(str::to_string),
        })
    }

    fn recorded(user_id: &str, auth_sid: Option<&str>) -> (Arc<Recorder>, Arc<Subscriber>) {
        let recorder = Arc::new(Recorder::default());
        let subscriber = subscriber(&recorder, auth_sid, false);
        register_subscriber(user_id, subscriber.clone());
        (recorder, subscriber)
    }

    fn plus(id: &str, n: f64) -> String {
        crate::js::number_to_string(parse_int(id).unwrap() + n)
    }

    #[test]
    fn subscribers_are_counted_per_user_and_dropped_one_at_a_time() {
        let _turn = turn();
        let (one, other) = (user(), user());
        assert_eq!(subscriber_count(&one), 0);
        let (_, first) = recorded(&one, None);
        let (_, second) = recorded(&one, None);
        let (_, theirs) = recorded(&other, None);
        assert_eq!((subscriber_count(&one), subscriber_count(&other)), (2, 1));
        unregister_subscriber(&one, &first);
        assert_eq!((subscriber_count(&one), subscriber_count(&other)), (1, 1));
        // Dropping one that is already gone, or a user's last, is harmless.
        unregister_subscriber(&one, &first);
        unregister_subscriber(&one, &second);
        unregister_subscriber(&one, &second);
        assert_eq!(subscriber_count(&one), 0);
        unregister_subscriber(&other, &theirs);
    }

    #[test]
    fn an_emit_reaches_every_subscriber_of_that_user_only_with_its_id_and_payload() {
        let _turn = turn();
        let (one, other) = (user(), user());
        let (first, _a) = recorded(&one, None);
        let (second, _b) = recorded(&one, None);
        let (theirs, _c) = recorded(&other, None);
        let base = current_event_id(&one);

        emit_to_user(&one, "transactions", Some("tab-1"));
        emit_to_user(&one, "accounts", None);

        let expected = vec![
            ("transactions-updated".to_string(), json!({ "originTabId": "tab-1" }), Some(plus(&base, 1.0))),
            ("accounts-updated".to_string(), json!({}), Some(plus(&base, 2.0))),
        ];
        assert_eq!(*first.sent.lock().unwrap(), expected);
        assert_eq!(*second.sent.lock().unwrap(), expected);
        assert!(theirs.sent.lock().unwrap().is_empty());
        // The other user's ids did not move.
        assert_eq!(current_event_id(&other), base);
        assert_eq!(current_event_id(&one), plus(&base, 2.0));
    }

    #[test]
    fn a_subscriber_that_fails_is_closed_and_does_not_hold_back_the_others() {
        let _turn = turn();
        let user_id = user();
        let failing = Arc::new(Recorder::default());
        register_subscriber(&user_id, subscriber(&failing, None, true));
        let (healthy, _keep) = recorded(&user_id, None);

        emit_to_user(&user_id, "charts", None);

        assert_eq!(healthy.sent.lock().unwrap().len(), 1);
        assert!(failing.closed.load(Ordering::SeqCst));
        assert!(!healthy.closed.load(Ordering::SeqCst));
    }

    #[test]
    fn events_are_buffered_whether_or_not_anyone_is_listening_and_outlive_the_last_subscriber() {
        let _turn = turn();
        let user_id = user();
        let base = current_event_id(&user_id);
        // Nobody listening: a new stream with no id has nothing to catch up on.
        let fresh = get_events_since(&user_id, None);
        assert!(fresh.events.is_empty() && !fresh.overflow);

        emit_to_user(&user_id, "budgets", Some("t1"));
        let (_, listener) = recorded(&user_id, None);
        emit_to_user(&user_id, "sections", None);
        unregister_subscriber(&user_id, &listener);
        emit_to_user(&user_id, "categories", None);

        let since = get_events_since(&user_id, Some(&base));
        assert!(!since.overflow);
        let replay: Vec<(&str, &str, &Json)> = since.events.iter().map(|e| (e.id.as_str(), e.domain.as_str(), &e.payload)).collect();
        let ids = [plus(&base, 1.0), plus(&base, 2.0), plus(&base, 3.0)];
        assert_eq!(
            replay,
            [
                (ids[0].as_str(), "budgets", &json!({ "originTabId": "t1" })),
                (ids[1].as_str(), "sections", &json!({})),
                (ids[2].as_str(), "categories", &json!({})),
            ]
        );
        // Only what came after the id asked for.
        let later = get_events_since(&user_id, Some(&ids[1]));
        assert_eq!(later.events.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), [ids[2].as_str()]);
    }

    #[test]
    fn what_a_reconnect_gets_depends_on_where_its_id_sits() {
        let _turn = turn();
        let user_id = user();
        let base = current_event_id(&user_id);
        let overflow = |id: Option<&str>| get_events_since(&user_id, id).overflow;
        let covered_with = |id: &str| {
            let since = get_events_since(&user_id, Some(id));
            assert!(!since.overflow, "{id}");
            since.events.len()
        };

        // Before any event: the starting id is the tip; anything else cannot be placed.
        assert_eq!(covered_with(&base), 0);
        assert!(overflow(Some(&plus(&base, -1.0))));
        assert!(overflow(Some(&plus(&base, 1.0))));
        assert!(overflow(Some("not-an-id")));
        assert!(!overflow(None));

        for _ in 0..3 {
            emit_to_user(&user_id, "transactions", None);
        }
        let tip = plus(&base, 3.0);
        assert_eq!(covered_with(&tip), 0);
        assert_eq!(covered_with(&plus(&base, 2.0)), 1);
        assert_eq!(covered_with(&base), 3);
        // An id is read as a whole number, like `parseInt`.
        assert_eq!(covered_with(&format!(" {}.9abc", plus(&base, 1.0))), 2);
        // Above the tip, before the first buffered event, unreadable, or none at all while events exist.
        assert!(overflow(Some(&plus(&tip, 1.0))));
        assert!(overflow(Some(&plus(&base, -1.0))));
        assert!(overflow(Some("0")));
        assert!(overflow(Some("")));
        assert!(overflow(Some("abc")));
        assert!(overflow(None));
    }

    #[test]
    fn the_buffer_keeps_the_newest_events_up_to_its_limit() {
        let _turn = turn();
        let user_id = user();
        let base = current_event_id(&user_id);
        let total = RING_BUFFER_MAX_ENTRIES + 5;
        for _ in 0..total {
            emit_to_user(&user_id, "transactions", None);
        }
        let tip = plus(&base, total as f64);
        assert_eq!(current_event_id(&user_id), tip);
        // The oldest five are gone: an id from before them cannot be replayed from.
        assert!(get_events_since(&user_id, Some(&base)).overflow);
        assert!(get_events_since(&user_id, Some(&plus(&base, 4.0))).overflow);
        // From the last evicted id on, everything kept is replayed.
        let kept = get_events_since(&user_id, Some(&plus(&base, 5.0)));
        assert!(!kept.overflow);
        assert_eq!(kept.events.len(), RING_BUFFER_MAX_ENTRIES);
        assert_eq!(kept.events.first().map(|e| e.id.clone()), Some(plus(&base, 6.0)));
        assert_eq!(kept.events.last().map(|e| e.id.clone()), Some(tip));
    }

    #[test]
    fn closing_by_user_or_by_sign_in_closes_those_streams_and_no_others() {
        let _turn = turn();
        let (one, other) = (user(), user());
        let (laptop, _a) = recorded(&one, Some("ses_laptop"));
        let (phone, _b) = recorded(&one, Some("ses_phone"));
        let (password, _c) = recorded(&one, None);
        let (theirs, _d) = recorded(&other, Some("ses_theirs"));
        let closed = |recorder: &Arc<Recorder>| recorder.closed.load(Ordering::SeqCst);

        close_subscribers(Which::AuthSid("ses_laptop"));
        assert_eq!((closed(&laptop), closed(&phone), closed(&password), closed(&theirs)), (true, false, false, false));
        assert_eq!((subscriber_count(&one), subscriber_count(&other)), (2, 1));
        close_subscribers(Which::AuthSid("ses_nobody"));
        assert_eq!((subscriber_count(&one), subscriber_count(&other)), (2, 1));

        close_subscribers(Which::UserId(&one));
        assert_eq!((closed(&phone), closed(&password), closed(&theirs)), (true, true, false));
        assert_eq!((subscriber_count(&one), subscriber_count(&other)), (0, 1));

        close_all_subscribers();
        assert!(closed(&theirs));
        assert_eq!(subscriber_count(&other), 0);
    }

    #[test]
    fn a_path_emits_for_its_table_only_under_a_verb_that_writes() {
        assert_eq!(mutation_emit_domain("POST", "/transaction"), Some("transactions"));
        assert_eq!(mutation_emit_domain("DELETE", "/transaction"), Some("transactions"));
        assert_eq!(mutation_emit_domain("POST", "/account"), Some("accounts"));
        assert_eq!(mutation_emit_domain("DELETE", "/account"), Some("accounts"));
        assert_eq!(mutation_emit_domain("POST", "/budget"), Some("budgets"));
        assert_eq!(mutation_emit_domain("POST", "/section"), Some("sections"));
        assert_eq!(mutation_emit_domain("POST", "/category"), Some("categories"));
        assert_eq!(mutation_emit_domain("POST", "/chart"), Some("charts"));
        assert_eq!(mutation_emit_domain("POST", "/split-transaction"), Some("split_transactions"));
        assert_eq!(mutation_emit_domain("POST", "/investment-transaction"), Some("investment_transactions"));
        assert_eq!(mutation_emit_domain("POST", "/snapshot"), Some("snapshots"));
        // A `/new-*` insert is a write, though a GET performs it.
        assert_eq!(mutation_emit_domain("GET", "/new-transaction"), Some("transactions"));
        assert_eq!(mutation_emit_domain("GET", "/new-budget"), Some("budgets"));
        assert_eq!(mutation_emit_domain("GET", "/new-chart"), Some("charts"));
        // Writes that touch several tables name the one a re-sync is keyed on.
        assert_eq!(mutation_emit_domain("POST", "/public-token"), Some("accounts"));
        assert_eq!(mutation_emit_domain("DELETE", "/item"), Some("accounts"));
        assert_eq!(mutation_emit_domain("POST", "/suggest-category"), Some("transactions"));
        // A read on a path that also has a write verb does not emit.
        assert_eq!(mutation_emit_domain("GET", "/snapshots/holding"), None);
        assert_eq!(mutation_emit_domain("POST", "/snapshots/holding"), Some("snapshots"));
        assert_eq!(mutation_emit_domain("GET", "/transfers"), None);
        assert_eq!(mutation_emit_domain("DELETE", "/transfers"), Some("transaction_pairs"));
        assert_eq!(mutation_emit_domain("POST", "/transfers/pair"), Some("transaction_pairs"));
        // Reads, and writes that are not to a data table.
        for (method, path) in [
            ("GET", "/transactions"),
            ("GET", "/accounts"),
            ("POST", "/login"),
            ("DELETE", "/login"),
            ("POST", "/api-keys"),
            ("DELETE", "/api-keys"),
            ("POST", "/validate-ticker"),
            ("POST", "/client-error"),
            ("POST", "/does-not-exist"),
        ] {
            assert_eq!(mutation_emit_domain(method, path), None, "{method} {path}");
        }
    }

    #[test]
    fn an_import_and_a_recurrings_write_also_emit_the_tables_they_change_on_the_side() {
        assert_eq!(mutation_emit_domain("POST", "/plan-statement/import"), Some("investment_transactions"));
        assert_eq!(mutation_side_effect_domains("POST", "/plan-statement/import"), ["accounts", "snapshots"]);
        assert_eq!(mutation_emit_domain("POST", "/recurrings"), Some("recurrings"));
        assert_eq!(mutation_side_effect_domains("POST", "/recurrings"), ["transactions", "split_transactions"]);
        // An ordinary write changes nothing beyond its own table, and a read nothing at all.
        assert!(mutation_side_effect_domains("POST", "/investment-transaction").is_empty());
        assert!(mutation_side_effect_domains("DELETE", "/investment-transaction").is_empty());
        assert!(mutation_side_effect_domains("GET", "/plan-statement/import").is_empty());
        assert!(mutation_side_effect_domains("GET", "/recurrings").is_empty());
    }
}
