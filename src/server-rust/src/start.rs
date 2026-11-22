//! The HTTP server and the path every API request takes through it:
//! `src/server/start.ts`.
//!
//! Requests under `/api` go through, in order: the pre-session rate limits,
//! body and query parsing, the session, API-key bearer auth, the
//! authentication gate, the route, and the session cookie on the way out.
//! Everything else is served from the client directory, falling back to
//! `index.html` for the single-page app.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

use bytes::Bytes;
use futures::StreamExt;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Empty, Full, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{HeaderName, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Response, StatusCode};
use hyper_util::rt::TokioIo;
use indexmap::IndexMap;
use serde_json::json;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::js::{json_parse, json_stringify, Json, Obj};
use crate::routes;
use crate::server::alarm::send_alarm;
use crate::server::bearer_auth::resolve_bearer_auth;
use crate::server::logger;
use crate::server::node_env::is_production;
use crate::server::postgres::{initialize_postgres, pool};
use crate::server::rate_limit::{get_client_ip, pre_session_shed_message, start_rate_limit_cleanup};
use crate::server::realtime::{self, mutation_emit_domain, mutation_side_effect_domains, origin_tab_payload, spawn_emit_to_sharing_group};
use crate::server::request_limits::MAX_REQUEST_BODY_SIZE;
use crate::server::route::{ApiResponse, Ctx, QueryValue, RawBody, Reply, Request, Route, Session};
use crate::server::security_headers::{response_security_headers, SECURITY_HEADERS};
use crate::server::session::{
    build_session_cookie, load_session_data, parse_cookies, save_session, SESSION_COOKIE_NAME, SESSION_MAX_AGE_S,
};
use crate::server::sso::{get_sso, initialize_sso, sso_public_path_methods, AUTH_CALLBACK_PATH, AUTH_EVENTS_PATH};

type Body = UnsyncBoxBody<Bytes, anyhow::Error>;
type HttpResponse = Response<Body>;

fn full(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into()).map_err(|never: Infallible| match never {}).boxed_unsync()
}

fn empty() -> Body {
    Empty::new().map_err(|never: Infallible| match never {}).boxed_unsync()
}

fn set_header(response: &mut HttpResponse, name: &str, value: &str) {
    // A header value is a byte string: each character up to U+00FF is sent as
    // its one byte, as Bun sends it.
    let Some(bytes) = value.chars().map(|c| u8::try_from(u32::from(c)).ok()).collect::<Option<Vec<u8>>>() else { return };
    if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_bytes(&bytes)) {
        response.headers_mut().append(name, value);
    }
}

/// A JSON answer from the HTTP layer itself, with the baseline security headers.
fn json_response(data: &Json, status: u16) -> HttpResponse {
    let mut response = Response::new(full(json_stringify(data)));
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    set_header(&mut response, "Content-Type", "application/json");
    for (name, value) in SECURITY_HEADERS {
        set_header(&mut response, name, value);
    }
    response
}

/// `true` for `/api` and its children, false for `/api-anything`.
pub fn is_api_path(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

async fn load_session(headers: &HashMap<String, String>) -> anyhow::Result<Session> {
    let cookie_header = headers.get("cookie").map(String::as_str).unwrap_or("");
    let cookies = parse_cookies(cookie_header).ok_or_else(|| anyhow::anyhow!("URI error"))?;
    // An empty session id is falsy in the TypeScript: it is never looked up.
    if let Some(sid) = cookies.get(SESSION_COOKIE_NAME).filter(|sid| !sid.is_empty()) {
        if let Ok(Some(data)) = load_session_data(sid).await {
            return Ok(Session {
                id: sid.clone(),
                user: Some(data.user),
                auth: data.auth,
                destroyed: false,
                stored: true,
                bearer: false,
            });
        }
    }
    Ok(Session { id: uuid::Uuid::new_v4().to_string(), user: None, auth: None, destroyed: false, stored: false, bearer: false })
}

/// The `Set-Cookie` value for the session after the route ran, if any.
async fn persist_session(session: &Session, secure: bool) -> anyhow::Result<Option<String>> {
    if session.destroyed {
        // Clear the cookie regardless of whether the session existed.
        return Ok(Some(build_session_cookie("", 0, secure)));
    }
    // Bearer-authenticated requests are stateless: never bind a session cookie
    // to the holder of an API key.
    if session.bearer {
        return Ok(None);
    }
    let Some(user) = &session.user else { return Ok(None) };
    save_session(&session.id, user, secure, session.stored).await?;
    Ok(Some(build_session_cookie(&session.id, SESSION_MAX_AGE_S, secure)))
}

/// Persists the session and assembles the headers every route response carries.
async fn final_response_headers(session: &Session, content_type: Option<&str>) -> Vec<(String, String)> {
    // Best-effort: the route already produced its response, and a dead
    // database must not replace it.
    let set_cookie = match persist_session(session, is_production()).await {
        Ok(cookie) => cookie,
        Err(error) => {
            logger::error("Session persist failed", None, Some(&error));
            None
        }
    };
    let mut headers: Vec<(String, String)> =
        response_security_headers().into_iter().map(|(name, value)| (name.to_string(), value.to_string())).collect();
    if let Some(cookie) = set_cookie {
        headers.push(("Set-Cookie".to_string(), cookie));
    }
    if let Some(content_type) = content_type {
        headers.push(("Content-Type".to_string(), content_type.to_string()));
    }
    headers
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

fn all_routes() -> &'static [Route] {
    static ROUTES: OnceLock<Vec<Route>> = OnceLock::new();
    ROUTES.get_or_init(routes::all)
}

/// Paths that answer without a session; `None` allows every method.
const PUBLIC_PATH_METHODS: [(&str, Option<&str>); 3] =
    [("/login", None), ("/plaid-hook", Some("POST")), ("/health", Some("GET"))];

fn is_public(method: &str, path: &str) -> bool {
    // The first entry for the path decides, as `Array.prototype.find` does.
    if let Some((_, allowed)) = PUBLIC_PATH_METHODS.iter().find(|(p, _)| *p == path) {
        return allowed.map(|m| m == method).unwrap_or(true);
    }
    sso_public_path_methods().iter().find(|(p, _)| *p == path).map(|(_, m)| *m == method).unwrap_or(false)
}

/// The body's field names only, never values, which can carry credentials.
fn payload_hint(body: &Option<Json>) -> Option<Vec<String>> {
    match body {
        Some(Json::Object(map)) if !map.is_empty() => Some(map.keys().cloned().collect()),
        _ => None,
    }
}

struct IncomingParts {
    method: String,
    url: url::Url,
    headers: HashMap<String, String>,
    body: Incoming,
    socket_ip: String,
}

async fn read_text(body: Incoming) -> anyhow::Result<String> {
    let collected = Limited::new(body, MAX_REQUEST_BODY_SIZE)
        .collect()
        .await
        .map_err(|error| anyhow::anyhow!("failed to read the request body: {error}"))?;
    let bytes = collected.to_bytes();
    let text = String::from_utf8_lossy(&bytes);
    // `Request.text()` drops a leading byte-order mark.
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

async fn handle_api_request(parts: IncomingParts, api_path: &str, log: &mut Obj) -> anyhow::Result<HttpResponse> {
    let IncomingParts { method, url, headers, body: incoming, socket_ip } = parts;
    let ip = get_client_ip(&headers, Some(&socket_ip));
    log.insert("ip".into(), json!(ip));

    if let Some(message) = pre_session_shed_message(&method, api_path, &ip) {
        return Ok(json_response(&ApiResponse::failed(message).to_json(), 429));
    }

    // Parse the body for JSON requests.
    let mut body: Option<Json> = None;
    let mut raw_body: Option<String> = None;
    let content_type = headers.get("content-type").map(String::as_str).unwrap_or("");
    if content_type.contains("application/json") {
        let text = read_text(incoming).await?;
        // A body that does not parse leaves `body` undefined.
        body = json_parse(&text);
        raw_body = Some(text);
    } else if api_path == AUTH_EVENTS_PATH {
        // A security event token arrives as `application/secevent+jwt`.
        raw_body = Some(read_text(incoming).await?);
    }
    if let Some(fields) = payload_hint(&body) {
        log.insert("bodyFields".into(), json!(fields));
    }

    // Parse query string params; a repeated name collects into an array.
    let mut query: IndexMap<String, QueryValue> = IndexMap::new();
    for (key, value) in url.query_pairs() {
        let (key, value) = (key.into_owned(), value.into_owned());
        match query.get_mut(&key) {
            Some(QueryValue::Many(values)) => values.push(value),
            Some(existing @ QueryValue::One(_)) => {
                let QueryValue::One(first) = existing.clone() else { unreachable!() };
                *existing = QueryValue::Many(vec![first, value]);
            }
            None => {
                query.insert(key, QueryValue::One(value));
            }
        }
    }
    // The callback's query carries a one-time authorization code.
    if !query.is_empty() && api_path != AUTH_CALLBACK_PATH {
        let logged: Obj = query.iter().map(|(key, value)| (key.clone(), value.to_json())).collect();
        log.insert("query".into(), Json::Object(logged));
    }

    let mut session = load_session(&headers).await?;
    let username = |session: &Session| session.user.as_ref().map(|u| u.username.clone()).unwrap_or_else(|| "anonymous".into());
    log.insert("user".into(), json!(username(&session)));

    // Look the route up first: its required scope decides whether a bearer
    // credential is consulted at all.
    let matched_route = all_routes().iter().find(|route| route.path == api_path && route.method == method);

    // Bearer auth: only on a route that declares a scope, and only when no
    // cookie session is present.
    let bearer = resolve_bearer_auth(
        headers.get("authorization").map(String::as_str),
        session.user.is_some(),
        matched_route.and_then(|route| route.required_scope),
        &ip,
    )
    .await?;
    match bearer {
        Err(_unavailable) => {
            return Ok(json_response(
                &ApiResponse::failed("Cannot check the API key right now. Try again later.").to_json(),
                503,
            ));
        }
        Ok(Some(user)) => {
            session.user = Some(user);
            session.bearer = true;
            log.insert("user".into(), json!(username(&session)));
            log.insert("auth".into(), json!("bearer"));
        }
        Ok(None) => {}
    }

    // Reject unauthenticated requests except on public paths.
    if !is_public(&method, api_path) && session.user.is_none() {
        return Ok(json_response(&ApiResponse::failed("Not authenticated.").to_json(), 401));
    }

    let Some(route) = matched_route else {
        return Ok(json_response(&ApiResponse::error("Not Found").to_json(), 404));
    };

    let disconnected = CancellationToken::new();
    let mut ctx = Ctx {
        req: Request {
            method: method.clone(),
            path: api_path.to_string(),
            url: url.to_string(),
            headers,
            query,
            body,
            raw_body,
            ip,
            disconnected: disconnected.clone(),
        },
        session,
        status: 200,
    };
    let reply = route.execute(&mut ctx).await;
    let status = StatusCode::from_u16(ctx.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);

    let (body, content_type) = match reply {
        // A route that owns its response (a redirect, a stream that stays
        // open) is passed through: no session cookie, no change event.
        Reply::Raw(raw) => {
            let body = match raw.body {
                RawBody::Empty => empty(),
                RawBody::Stream(stream) => {
                    let guard = disconnected.drop_guard();
                    let frames = stream.map(move |chunk| {
                        let _held = &guard;
                        Ok::<_, anyhow::Error>(Frame::data(chunk))
                    });
                    BodyExt::boxed_unsync(StreamBody::new(frames))
                }
            };
            let mut response = Response::new(body);
            *response.status_mut() = StatusCode::from_u16(raw.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            for (name, value) in &raw.headers {
                set_header(&mut response, name, value);
            }
            return Ok(response);
        }
        Reply::Stream(stream) => {
            let (log_method, log_path) = (method.clone(), api_path.to_string());
            let frames = stream.into_chunks().map(move |chunk| match chunk {
                Ok(bytes) => Ok(Frame::data(bytes)),
                Err(error) => {
                    logger::error(
                        "Streamed response failed",
                        Some(&crate::ctx! { "method": log_method, "path": log_path }),
                        Some(&error),
                    );
                    let title = format!("Route Error: {log_method} {log_path}");
                    let detail = format!("**Error:** {error}");
                    tokio::spawn(async move { send_alarm(&title, &detail, None, false).await });
                    Err(error)
                }
            });
            (BodyExt::boxed_unsync(StreamBody::new(frames)), Some("application/json"))
        }
        Reply::Api(result) => {
            // A successful mutation tells the open tabs of the acting user and
            // of everyone sharing data with them to re-sync. The caller's
            // `X-Tab-Id` is echoed so the tab that made the change can skip
            // its own event.
            if let (Some(domain), "success", Some(user)) =
                (mutation_emit_domain(&method, api_path), result.status, &ctx.session.user)
            {
                spawn_emit_to_sharing_group(&user.user_id, domain, origin_tab_payload(&ctx.req.headers));
                for side_effect in mutation_side_effect_domains(&method, api_path) {
                    spawn_emit_to_sharing_group(&user.user_id, side_effect, None);
                }
            }
            (full(json_stringify(&result.to_json())), Some("application/json"))
        }
        Reply::None => (empty(), None),
    };

    let mut response = Response::new(body);
    *response.status_mut() = status;
    for (name, value) in final_response_headers(&ctx.session, content_type).await {
        set_header(&mut response, &name, &value);
    }
    Ok(response)
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

/// The directory the client is served from: `CLIENT_DIR`, or `../client`
/// next to the directory holding the executable, the layout `build/` has.
fn client_dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| match std::env::var("CLIENT_DIR").ok().filter(|dir| !dir.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().and_then(Path::parent).map(|root| root.join("client")))
            .unwrap_or_else(|| PathBuf::from("client")),
    })
}

/// The content type for a file name, as Bun's static responses label them.
fn content_type_of(path: &Path) -> &'static str {
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "html" | "htm" => "text/html;charset=utf-8",
        "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx" | "mts" | "cts" => "text/javascript;charset=utf-8",
        "css" => "text/css;charset=utf-8",
        "json" | "map" => "application/json;charset=utf-8",
        "webmanifest" => "application/manifest+json",
        "txt" | "log" | "conf" | "ini" => "text/plain;charset=utf-8",
        "csv" => "text/csv",
        "md" => "text/markdown",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/x-ms-bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "wav" => "audio/x-wav",
        _ => "application/octet-stream",
    }
}

/// A single `bytes=` range against a body of `size` bytes: `Ok(None)` serves
/// the whole body (no range, several ranges, another unit), `Err` is unsatisfiable.
fn parse_range(header: Option<&String>, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = header.and_then(|value| value.trim().strip_prefix("bytes=")) else { return Ok(None) };
    if spec.contains(',') {
        return Ok(None);
    }
    let Some((start, end)) = spec.split_once('-') else { return Ok(None) };
    let (start, end) = (start.trim(), end.trim());
    if start.is_empty() {
        let Ok(suffix) = end.parse::<u64>() else { return Ok(None) };
        if suffix == 0 || size == 0 {
            return Err(());
        }
        return Ok(Some((size.saturating_sub(suffix), size - 1)));
    }
    let Ok(start) = start.parse::<u64>() else { return Ok(None) };
    if start >= size {
        return Err(());
    }
    let end = match end {
        "" => size - 1,
        text => match text.parse::<u64>() {
            Ok(end) if end >= start => end.min(size - 1),
            Ok(_) => return Ok(None),
            Err(_) => return Ok(None),
        },
    };
    Ok(Some((start, end)))
}

async fn serve_static(method: &str, full_path: &str, headers: &HashMap<String, String>) -> HttpResponse {
    let root = client_dir();
    let index = root.join("index.html");
    // The path is used as written: nothing is percent-decoded, and the URL
    // parser has already resolved every `..`.
    let candidate = if full_path == "/" { index.clone() } else { root.join(full_path.trim_start_matches('/')) };
    let is_file = |path: PathBuf| async move {
        match tokio::fs::metadata(&path).await {
            Ok(meta) if meta.is_file() => Some(path),
            _ => None,
        }
    };
    let file = match is_file(candidate).await {
        Some(path) => path,
        // The single-page app's own routes all load the shell.
        None => index,
    };
    let Ok(bytes) = tokio::fs::read(&file).await else {
        let mut response = Response::new(empty());
        *response.status_mut() = StatusCode::NOT_FOUND;
        return response;
    };
    let size = bytes.len() as u64;
    let is_head = method == "HEAD";

    let mut response = match parse_range(headers.get("range"), size) {
        Err(()) => {
            let mut response = Response::new(empty());
            *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
            set_header(&mut response, "content-range", &format!("bytes */{size}"));
            set_header(&mut response, "accept-ranges", "bytes");
            return response;
        }
        Ok(Some((start, end))) => {
            let slice = Bytes::from(bytes).slice(start as usize..=end as usize);
            let length = slice.len();
            let mut response = Response::new(if is_head { empty() } else { full(slice) });
            *response.status_mut() = StatusCode::PARTIAL_CONTENT;
            set_header(&mut response, "content-range", &format!("bytes {start}-{end}/{size}"));
            set_header(&mut response, "accept-ranges", "bytes");
            set_header(&mut response, "content-length", &length.to_string());
            response
        }
        Ok(None) => {
            let mut response = Response::new(if is_head { empty() } else { full(bytes) });
            set_header(&mut response, "content-length", &size.to_string());
            response
        }
    };
    if !is_head {
        set_header(&mut response, "content-type", content_type_of(&file));
    }
    response
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

fn payload_too_large() -> HttpResponse {
    let mut response = Response::new(empty());
    *response.status_mut() = StatusCode::PAYLOAD_TOO_LARGE;
    set_header(&mut response, "Connection", "close");
    response
}

fn internal_error() -> HttpResponse {
    let mut response = Response::new(full("Internal Server Error"));
    *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
    set_header(&mut response, "content-type", "text/html;charset=utf-8");
    response
}

async fn handle(request: hyper::Request<Incoming>, peer: SocketAddr) -> Result<HttpResponse, Infallible> {
    let (head, body) = request.into_parts();
    let method = head.method.as_str().to_string();

    // An over-limit body is refused before anything reads it.
    let declared_length = head.headers.get(hyper::header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    if declared_length.map(|length| length > MAX_REQUEST_BODY_SIZE as u64).unwrap_or(false) {
        return Ok(payload_too_large());
    }

    // Header values by lower-case name; a repeated header joins with ", ".
    let mut headers: HashMap<String, String> = HashMap::new();
    for (name, value) in &head.headers {
        // A header value is a byte string: each byte is one character, as Bun reads it.
        let value: String = value.as_bytes().iter().map(|&byte| char::from(byte)).collect();
        headers
            .entry(name.as_str().to_string())
            .and_modify(|existing| {
                existing.push_str(", ");
                existing.push_str(&value);
            })
            .or_insert(value);
    }

    let host = headers.get("host").cloned().unwrap_or_else(|| "localhost".to_string());
    let target = head.uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
    let Ok(url) = url::Url::parse(&format!("http://{host}{target}")) else {
        return Ok(internal_error());
    };
    let full_path = url.path().to_string();

    // Serve static files for non-API paths. `/api-anything` is a client route.
    if !is_api_path(&full_path) {
        // A chunked body has no declared length; one past the limit is still refused.
        if declared_length.is_none()
            && head.method != Method::GET
            && head.method != Method::HEAD
            && Limited::new(body, MAX_REQUEST_BODY_SIZE).collect().await.is_err()
        {
            return Ok(payload_too_large());
        }
        return Ok(serve_static(&method, &full_path, &headers).await);
    }

    // Strip the /api prefix to get the route path.
    let api_path = match &full_path[4..] {
        "" => "/".to_string(),
        rest => rest.to_string(),
    };

    let started = Instant::now();
    let mut log = Obj::new();
    log.insert("method".into(), json!(method));
    log.insert("path".into(), json!(full_path));

    let is_head = head.method == Method::HEAD;
    let parts = IncomingParts { method, url, headers, body, socket_ip: peer.ip().to_string() };
    let mut response = match handle_api_request(parts, &api_path, &mut log).await {
        Ok(response) => response,
        Err(error) if error.to_string().contains("length limit exceeded") => payload_too_large(),
        Err(error) => {
            logger::error("Unhandled request error", Some(&log), Some(&error));
            internal_error()
        }
    };

    // /health is polled constantly by uptime checks: keep it out of the log.
    if api_path != "/health" {
        log.insert("status".into(), json!(response.status().as_u16()));
        log.insert("durationMs".into(), json!(started.elapsed().as_millis() as u64));
        logger::info("API request", Some(&log));
    }

    if is_head {
        // A HEAD response describes the body without carrying it.
        let (parts, body) = response.into_parts();
        let length = body.collect().await.map(|collected| collected.to_bytes().len()).unwrap_or(0);
        response = Response::from_parts(parts, empty());
        set_header(&mut response, "content-length", &length.to_string());
    }
    Ok(response)
}

async fn shutdown_signal() -> &'static str {
    use tokio::signal::unix::{signal, SignalKind};
    let mut terminate = signal(SignalKind::terminate()).expect("a SIGTERM handler can be installed");
    let mut interrupt = signal(SignalKind::interrupt()).expect("a SIGINT handler can be installed");
    tokio::select! {
        _ = terminate.recv() => "SIGTERM",
        _ = interrupt.recv() => "SIGINT",
    }
}

/// Boots the app and serves until a termination signal.
pub async fn run() -> anyhow::Result<()> {
    crate::server::polygon::initialize();

    // Settings only: nothing here contacts the identity provider, so the app
    // starts whether or not it is reachable. A bad setting stops the start.
    initialize_sso()?;
    if let Some(sso) = get_sso() {
        logger::info(
            "Single sign-on is on",
            Some(&crate::ctx! { "issuer": sso.config.issuer, "localLogin": sso.config.local_login }),
        );
    }

    crate::server::plaid::util::warn_if_not_configured();
    realtime::initialize();
    initialize_postgres().await?;
    start_rate_limit_cleanup();
    crate::server::compute_tools::schedule::scheduled_sync();

    let port: u16 = std::env::var("PORT").ok().and_then(|port| port.parse().ok()).unwrap_or(3005);
    let listener = TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port))).await?;
    logger::info("Budget app server is up", Some(&crate::ctx! { "port": listener.local_addr()?.port() }));

    let accept = async {
        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(error) => {
                    logger::warn("Failed to accept a connection", None, Some(&anyhow::Error::new(error)));
                    continue;
                }
            };
            let _ = stream.set_nodelay(true);
            tokio::spawn(async move {
                let service = service_fn(move |request| handle(request, peer));
                // A connection that fails mid-flight has nobody left to answer.
                let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
            });
        }
    };

    let signal = tokio::select! {
        signal = shutdown_signal() => signal,
        _ = accept => unreachable!("the accept loop never ends"),
    };
    logger::info(&format!("{signal} received — shutting down gracefully"), None);
    crate::server::compute_tools::schedule::stop_scheduled_sync();
    logger::info("HTTP server closed", None);
    pool().end();
    logger::info("Database pool closed", None);
    Ok(())
}
