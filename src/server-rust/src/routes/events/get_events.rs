//! `GET /events`: the server-sent event stream each open tab holds.
//! `src/server/routes/events/get-events.ts`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use futures::StreamExt;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_util::sync::CancellationToken;

use crate::js::{json_stringify, parse_int, Json};
use crate::server::logger;
use crate::server::realtime::{
    current_event_id, get_events_since, register_subscriber, subscriber_count, unregister_subscriber, EventsSince, Subscriber,
    SSE_IDLE_TIMEOUT_SECONDS, SSE_KEEPALIVE_MS,
};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, RawBody, RawResponse, Reply, Route};
use crate::server::security_headers::SECURITY_HEADERS;
use crate::server::session::{watch_session, SESSION_WATCH_INTERVAL};
use crate::server::sso::get_sso;
use crate::server::validation::optional_query_string;

// Bound the number of concurrent tabs per user so a bug or abuse can't grow
// the subscriber map without limit. Each stream holds a keepalive task and a
// channel. 20 is comfortably above normal (a few tabs + a few devices) while
// still tripping on runaway reconnect loops.
const MAX_SUBSCRIBERS_PER_USER: usize = 20;

fn sse_headers() -> Vec<(String, String)> {
    let stream_headers = [
        ("Content-Type", "text/event-stream"),
        ("Cache-Control", "no-cache, no-transform"),
        ("Connection", "keep-alive"),
        ("X-Accel-Buffering", "no"),
    ];
    SECURITY_HEADERS.iter().chain(&stream_headers).map(|(name, value)| (name.to_string(), value.to_string())).collect()
}

// `id:` precedes `event:`/`data:` per the SSE spec so the browser captures it
// before dispatch and can echo it as Last-Event-ID.
fn format_sse_block(event: &str, payload: &Json, id: Option<&str>) -> Bytes {
    let id_line = id.map(|id| format!("id: {id}\n")).unwrap_or_default();
    Bytes::from(format!("{id_line}event: {event}\ndata: {}\n\n", json_stringify(payload)))
}

const RETRY_FULL_EVENT: &str = "retry-full";

/// Carries the current event id, so a client that reconnects before any event
/// arrives still has an id to resume from.
const CONNECTED_EVENT: &str = "connected";

/// One open stream: what its subscriber, its keepalive and its session watch share.
struct OpenStream {
    user_id: String,
    /// The response body's chunks. `None` ends the response once everything
    /// queued before it has been sent.
    chunks: mpsc::UnboundedSender<Option<Bytes>>,
    closed: AtomicBool,
    /// Live events that arrive while the replay is being written, by id;
    /// `None` once the stream is live. Requests run in parallel here, so an
    /// event can be emitted between reading the replay and going live.
    held: Mutex<Option<Vec<(f64, Bytes)>>>,
    subscriber: Mutex<Option<Arc<Subscriber>>>,
    session_watch: Mutex<Option<JoinHandle<()>>>,
    /// Cancelled by `cleanup`, to stop the keepalive.
    ended: CancellationToken,
}

impl OpenStream {
    fn write(&self, chunk: Bytes) -> bool {
        self.chunks.send(Some(chunk)).is_ok()
    }

    /// Releases everything the stream holds and ends the response. Runs once,
    /// whoever asks first: the client going away, the registry closing the
    /// subscriber, or the session ending.
    fn cleanup(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.ended.cancel();
        let session_watch = self.session_watch.lock().unwrap().take();
        if let Some(session_watch) = session_watch {
            session_watch.abort();
        }
        let subscriber = self.subscriber.lock().unwrap().take();
        if let Some(subscriber) = subscriber {
            unregister_subscriber(&self.user_id, &subscriber);
        }
        logger::info(
            "SSE unsubscribed",
            Some(&crate::ctx! { "userId": self.user_id, "remaining": subscriber_count(&self.user_id) }),
        );
        // The client may already be gone, and the channel with it.
        let _ = self.chunks.send(None);
    }
}

/// Makes "count the user's streams, then add one" a single step, so parallel
/// requests cannot pass the cap together.
static OPENING: Mutex<()> = Mutex::new(());

async fn get_events(ctx: &mut Ctx) -> HandlerResult {
    let user_id = ctx.user().map(|user| user.user_id.clone()).ok_or_else(|| anyhow::anyhow!("the event stream has no user"))?;

    ctx.req.idle_timeout.set(SSE_IDLE_TIMEOUT_SECONDS);

    // Headers are lowercased. The query parameter is how the client's own
    // reconnect sends it: a new EventSource can't set headers, and only the
    // browser's native retry echoes the header.
    let last_event_id_query = optional_query_string(&ctx.req, "last-event-id").ok().flatten();
    let last_event_id = match ctx.req.headers.get("last-event-id") {
        Some(header) => Some(header.clone()),
        None => last_event_id_query,
    }
    .filter(|id| !id.is_empty());

    let (chunks, receiver) = mpsc::unbounded_channel();
    let stream = Arc::new(OpenStream {
        user_id: user_id.clone(),
        chunks,
        closed: AtomicBool::new(false),
        held: Mutex::new(Some(Vec::new())),
        subscriber: Mutex::new(None),
        session_watch: Mutex::new(None),
        ended: CancellationToken::new(),
    });

    let (sending, closing) = (stream.clone(), stream.clone());
    let subscriber = Arc::new(Subscriber {
        send: Box::new(move |event, payload, id| {
            if sending.closed.load(Ordering::SeqCst) {
                return Ok(());
            }
            let chunk = format_sse_block(event, payload, id);
            let mut held = sending.held.lock().unwrap();
            match held.as_mut() {
                Some(held) => held.push((id.and_then(parse_int).unwrap_or(f64::NAN), chunk)),
                // A failed write means the client is gone; the keepalive task
                // is about to notice and clean up.
                None => drop(sending.write(chunk)),
            }
            Ok(())
        }),
        close: Box::new(move || closing.cleanup()),
        auth_sid: ctx.session.auth.as_ref().map(|auth| auth.sid.clone()),
    });

    // The subscriber is registered before the replay is read, holding back
    // what it receives, so replay stays ordered strictly before any live
    // event and nothing emitted in between is lost or sent twice.
    {
        let _opening = OPENING.lock().unwrap();
        if subscriber_count(&user_id) >= MAX_SUBSCRIBERS_PER_USER {
            ctx.status = 429;
            return Ok(ApiResponse::failed("Too many open event streams for this user.").into());
        }
        *stream.subscriber.lock().unwrap() = Some(subscriber.clone());
        register_subscriber(&user_id, subscriber);
    }

    // Prime the connection so the browser fires `onopen` immediately and any
    // proxy in front of us commits to streaming rather than buffering.
    stream.write(Bytes::from_static(b": connected\n\n"));

    let tip = current_event_id(&user_id);
    let tip_number = parse_int(&tip).unwrap_or(f64::NAN);
    let EventsSince { events, overflow } = get_events_since(&user_id, last_event_id.as_deref());
    // An event newer than the tip arrives through the subscriber instead.
    let replay: Vec<_> = events.into_iter().filter(|event| parse_int(&event.id).map(|id| id <= tip_number).unwrap_or(false)).collect();
    if overflow {
        stream.write(format_sse_block(RETRY_FULL_EVENT, &json!({}), None));
    } else {
        for event in &replay {
            stream.write(format_sse_block(&format!("{}-updated", event.domain), &event.payload, Some(&event.id)));
        }
    }
    stream.write(format_sse_block(CONNECTED_EVENT, &json!({}), Some(&tip)));
    {
        let mut held = stream.held.lock().unwrap();
        for (id, chunk) in held.take().unwrap_or_default() {
            if id > tip_number {
                stream.write(chunk);
            }
        }
    }

    // With single sign-on on, a session can end on another copy of the app,
    // where this stream's subscriber cannot be reached.
    if get_sso().is_some() {
        let watched = stream.clone();
        let session_watch = watch_session(ctx.session.id.clone(), move || watched.cleanup(), SESSION_WATCH_INTERVAL);
        if stream.closed.load(Ordering::SeqCst) {
            session_watch.abort();
        } else {
            *stream.session_watch.lock().unwrap() = Some(session_watch);
        }
    }
    logger::info(
        "SSE subscribed",
        Some(&crate::ctx! {
            "userId": user_id,
            "total": subscriber_count(&user_id),
            "replayed": replay.len(),
            "retryFull": overflow,
        }),
    );

    // Keep proxies from timing the connection out; also lets the client
    // detect a dead connection via missed pings. The same task notices the
    // client going away: the response, and with it the channel's receiving
    // end, is dropped.
    let pump = stream.clone();
    tokio::spawn(async move {
        let period = Duration::from_millis(SSE_KEEPALIVE_MS);
        let mut keepalive = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        loop {
            tokio::select! {
                _ = pump.ended.cancelled() => break,
                _ = pump.chunks.closed() => break,
                _ = keepalive.tick() => {
                    if !pump.write(Bytes::from_static(b": keepalive\n\n")) {
                        break;
                    }
                }
            }
        }
        pump.cleanup();
    });

    let body = UnboundedReceiverStream::new(receiver)
        .take_while(|chunk| futures::future::ready(chunk.is_some()))
        .filter_map(futures::future::ready)
        .boxed();
    Ok(Reply::Raw(RawResponse { status: 200, headers: sse_headers(), body: RawBody::Stream(body) }))
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/events", get_events)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_block_puts_the_id_first_and_ends_with_a_blank_line() {
        assert_eq!(
            format_sse_block("budgets-updated", &json!({ "originTabId": "tab \"A\"" }), Some("1700000000001")),
            "id: 1700000000001\nevent: budgets-updated\ndata: {\"originTabId\":\"tab \\\"A\\\"\"}\n\n"
        );
        assert_eq!(format_sse_block("retry-full", &json!({}), None), "event: retry-full\ndata: {}\n\n");
    }

    #[test]
    fn the_stream_is_marked_as_one_no_proxy_should_buffer_or_cache() {
        let headers = sse_headers();
        let value = |name: &str| headers.iter().find(|(header, _)| header == name).map(|(_, value)| value.as_str());
        assert_eq!(value("Content-Type"), Some("text/event-stream"));
        assert_eq!(value("Cache-Control"), Some("no-cache, no-transform"));
        assert_eq!(value("Connection"), Some("keep-alive"));
        assert_eq!(value("X-Accel-Buffering"), Some("no"));
        assert_eq!(value("X-Content-Type-Options"), Some("nosniff"));
        // The baseline headers only: transport security is the session routes' to add.
        assert_eq!(value("Strict-Transport-Security"), None);
    }
}
