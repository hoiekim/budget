//! The client behind `auth_client.rs`: the port of `createAuthClient` in the
//! vendored `src/server/lib/auth-client.ts`. It speaks the standard parts
//! (discovery, the code flow with PKCE, JWKS) to any OpenID Connect provider,
//! plus introspection of API keys with its cache, and security events.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures::future::{BoxFuture, FutureExt, Shared};
use indexmap::IndexMap;
use rand::RngCore;
use serde_json::json;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use url::Url;

use super::auth_client::*;
use crate::js::{encode_uri_component, js_length, js_slice_start, json_parse, json_stringify, num, to_js_string, truthy, Json, JsDate, Obj};
use crate::server::bearer_auth::is_ip;
use crate::server::validation::js_trim;

const LEEWAY_S: f64 = 30.0;
const LOGIN_COOKIE: &str = "__Host-login";
const LOGIN_TTL_S: u32 = 300;
const TIMEOUT: Duration = Duration::from_millis(5_000);
const JWKS_TTL_MS: f64 = 3_600_000.0;
const JWKS_MIN_INTERVAL_MS: f64 = 30_000.0;
const FRESH_MS: f64 = 60_000.0;
const STALE_MS: f64 = 600_000.0;
const CACHE_MAX: usize = 10_000;
const LOOPBACK: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];
const COOKIE_ATTRIBUTES: &str = "Path=/; Secure; HttpOnly; SameSite=Lax";

/// Own properties aside, what a JavaScript object literal answers a lookup
/// with: the members of `Object.prototype`. The TypeScript finds an event
/// type's required fields in such an object, so a type with one of these
/// names is not "unknown" there: reading its fields fails.
const OBJECT_PROTOTYPE_MEMBERS: [&str; 12] = [
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
];

fn other(message: impl Into<String>) -> AuthError {
    AuthError::Other(message.into())
}

fn unavailable(message: impl Into<String>) -> AuthError {
    AuthError::Unavailable(message.into())
}

fn invalid_token(message: impl Into<String>) -> AuthError {
    AuthError::InvalidToken(message.into())
}

fn login_error(code: &'static str) -> AuthError {
    AuthError::Login { code, error: None }
}

/// A call several requests wait on at once: all of them get its one outcome.
type Pending<T> = Shared<BoxFuture<'static, Result<T, AuthError>>>;

/// Runs `work` to its end whether or not anyone still waits for it, the way a
/// JavaScript promise does.
fn detached<T: Clone + Send + Sync + 'static>(work: impl std::future::Future<Output = Result<T, AuthError>> + Send + 'static) -> Pending<T> {
    let task = tokio::spawn(work);
    async move { task.await.unwrap_or_else(|_| Err(other("the call to auth was interrupted"))) }.boxed().shared()
}

/// Milliseconds since the epoch.
type Clock = Box<dyn Fn() -> f64 + Send + Sync>;

struct Keys {
    /// The provider's Ed25519 public keys by `kid`, as published: a key that
    /// is not a point on the curve verifies nothing.
    by_kid: HashMap<String, [u8; 32]>,
    fetched_at: f64,
    last_attempt: f64,
    loading: Option<Pending<()>>,
}

struct CachedIntrospection {
    answer: Introspection,
    at: f64,
}

/// Puts an answer at the young end of the cache, and drops the oldest entry
/// once there are more than `max`.
fn remember(cache: &mut IndexMap<String, CachedIntrospection>, key: String, entry: CachedIntrospection, max: usize) {
    cache.shift_remove(&key);
    cache.insert(key, entry);
    if cache.len() > max {
        cache.shift_remove_index(0);
    }
}

struct Inner {
    issuer: String,
    client_id: String,
    client_secret: Option<String>,
    redirect_uri: String,
    audience: String,
    issuer_base: String,
    back_base: Option<String>,
    now: Clock,
    /// The discovery document, once loading it has started; forgotten again when loading fails.
    discovery: Mutex<Option<(u64, Pending<Arc<Obj>>)>>,
    discovery_loads: AtomicU64,
    keys: Mutex<Keys>,
    /// Introspection answers by the digest of the secret, oldest first, so the
    /// cache never holds a usable secret.
    cache: Mutex<IndexMap<String, CachedIntrospection>>,
}

pub struct AuthClient {
    inner: Arc<Inner>,
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/// The client for calls to the identity provider. Like the shared one
/// (`alarm::http_client`) it honours the proxy environment and the system
/// certificate store, but it never follows a redirect.
fn http() -> &'static reqwest::Client {
    static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("the HTTP client has valid settings")
    });
    &CLIENT
}

fn is_ok(status: u16) -> bool {
    (200..300).contains(&status)
}

async fn call(request: reqwest::RequestBuilder) -> Result<reqwest::Response, AuthError> {
    let response = request.timeout(TIMEOUT).send().await.map_err(|_| unavailable("auth is unreachable"))?;
    let status = response.status().as_u16();
    if status >= 500 {
        return Err(unavailable(format!("auth answered {status}")));
    }
    Ok(response)
}

async fn read_json(response: reqwest::Response) -> Result<Obj, AuthError> {
    let status = response.status().as_u16();
    let malformed = || unavailable(format!("auth answered {status} with a malformed body"));
    let bytes = response.bytes().await.map_err(|_| malformed())?;
    let text = String::from_utf8_lossy(&bytes);
    match json_parse(text.strip_prefix('\u{feff}').unwrap_or(&text)) {
        Some(Json::Object(body)) => Ok(body),
        _ => Err(malformed()),
    }
}

// ---------------------------------------------------------------------------
// Small pure pieces
// ---------------------------------------------------------------------------

/// `Buffer.from(text, "base64url")`: either alphabet, no padding needed,
/// characters outside the alphabet skipped, a dangling character dropped.
fn decode_base64url(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut bits: u32 = 0;
    let mut count = 0;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(value);
        count += 1;
        if count == 4 {
            out.extend_from_slice(&[(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]);
            bits = 0;
            count = 0;
        }
    }
    match count {
        2 => out.push((bits >> 4) as u8),
        3 => out.extend_from_slice(&[(bits >> 10) as u8, (bits >> 2) as u8]),
        _ => {}
    }
    out
}

fn encode_base64url(bytes: impl AsRef<[u8]>) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// `/^[A-Za-z0-9_-]+$/`.
fn is_base64url(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The JSON object a base64url segment encodes.
fn parse_segment(segment: &str) -> Result<Obj, AuthError> {
    match json_parse(&String::from_utf8_lossy(&decode_base64url(segment))) {
        Some(Json::Object(value)) => Ok(value),
        _ => Err(invalid_token("malformed segment")),
    }
}

/// The first cookie named `name` in a `Cookie` header.
fn read_cookie<'a>(header: Option<&'a str>, name: &str) -> Option<&'a str> {
    for part in header.unwrap_or("").split(';') {
        if let Some(eq) = part.find('=') {
            if eq > 0 && js_trim(&part[..eq]) == name {
                return Some(js_trim(&part[eq + 1..]));
            }
        }
    }
    None
}

fn origin_of(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// A path on the app's own origin. URL parsers drop tabs and newlines and read
/// a backslash as a slash, so "/\t/evil.example" would lead off-site: any
/// control character, space or backslash is refused, and the path must still
/// resolve to the same origin.
fn is_local_path(path: &str) -> bool {
    if js_length(path) > 2048 || !path.starts_with('/') || path.starts_with("//") {
        return false;
    }
    if path.chars().any(|c| c <= '\u{20}' || c == '\u{7f}' || c == '\\') {
        return false;
    }
    let Ok(base) = Url::parse("https://app.invalid") else { return false };
    base.join(path).map(|url| origin_of(&url) == "https://app.invalid").unwrap_or(false)
}

fn same_digest(a: &str, b: &str) -> bool {
    bool::from(Sha256::digest(a.as_bytes()).ct_eq(&Sha256::digest(b.as_bytes())))
}

fn random() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    encode_base64url(bytes)
}

/// RFC 6749 §2.3.1: how each part of a client's credentials is encoded before Basic encoding.
fn form_encode(text: &str) -> String {
    encode_uri_component(text).replace("%20", "+")
}

/// The provider's `error` code when it is one, else the status.
fn error_code(answer: &Obj, status: u16) -> String {
    match answer.get("error").and_then(Json::as_str) {
        Some(error)
            if (1..=64).contains(&error.len())
                && error.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-')) =>
        {
            error.to_string()
        }
        _ => status.to_string(),
    }
}

/// `url.searchParams.set(name, value)` for each pair, in order.
fn set_search_params(url: &mut Url, params: &[(&str, String)]) {
    let mut pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    for (name, value) in params {
        match pairs.iter().position(|(existing, _)| existing == name) {
            Some(first) => {
                pairs[first].1 = value.clone();
                let mut index = 0;
                pairs.retain(|(existing, _)| {
                    let keep = index <= first || existing != name;
                    index += 1;
                    keep
                });
            }
            None => pairs.push((name.to_string(), value.clone())),
        }
    }
    url.query_pairs_mut().clear().extend_pairs(pairs);
}

/// `new URL(text)` for an endpoint the discovery document names.
fn endpoint_url(text: &str) -> Result<Url, AuthError> {
    Url::parse(text).map_err(|_| other("Invalid URL"))
}

/// An optional endpoint of the discovery document; `None` where the TypeScript finds it falsy.
fn optional_endpoint<'a>(discovery: &'a Obj, field: &str) -> Option<&'a Json> {
    discovery.get(field).filter(|value| truthy(value))
}

/// An endpoint a request is posted to. The TypeScript fails on one that is not text.
fn posted_endpoint(endpoint: &Json) -> Result<&str, AuthError> {
    endpoint.as_str().ok_or_else(|| {
        other("endpoint.startsWith is not a function. (In 'endpoint.startsWith(`${issuerBase}/`)', 'endpoint.startsWith' is undefined)")
    })
}

fn import_key(jwk: &Json) -> Option<(String, [u8; 32])> {
    let jwk = jwk.as_object()?;
    if jwk.get("kty").and_then(Json::as_str) != Some("OKP") || jwk.get("crv").and_then(Json::as_str) != Some("Ed25519") {
        return None;
    }
    let x = jwk.get("x")?.as_str()?;
    let kid = jwk.get("kid")?.as_str()?;
    let other_than = |field: &str, wanted: &str| jwk.get(field).map(|value| value.as_str() != Some(wanted)).unwrap_or(false);
    if other_than("use", "sig") || other_than("alg", "EdDSA") {
        return None;
    }
    let key: [u8; 32] = decode_base64url(x).try_into().ok()?;
    Some((kid.to_string(), key))
}

/// The fields each known event type must carry, in the order they are read.
fn event_fields(event_type: &str) -> Option<&'static [&'static str]> {
    match event_type {
        "session.ended" => Some(&["sid"]),
        "access.changed" => Some(&["sub"]),
        "user.disabled" => Some(&["sub"]),
        "invite.accepted" => Some(&["invite", "sub"]),
        "user.deleted" => Some(&["sub"]),
        "credential.revoked" => Some(&["sub", "id"]),
        _ => None,
    }
}

struct UrlParts {
    scheme: String,
    hostname: String,
    has_search: bool,
    has_hash: bool,
}

fn parse_url(value: &str, name: &str) -> Result<UrlParts, AuthError> {
    if value.is_empty() {
        return Err(other(format!("{name} is required")));
    }
    let url = Url::parse(value).map_err(|_| other(format!("{name} must be an absolute URL")))?;
    Ok(UrlParts {
        scheme: url.scheme().to_string(),
        hostname: crate::server::sso::hostname_of(&url),
        has_search: url.query().map(|query| !query.is_empty()).unwrap_or(false),
        has_hash: url.fragment().map(|fragment| !fragment.is_empty()).unwrap_or(false),
    })
}

fn check_options(options: &AuthClientOptions) -> Result<(), AuthError> {
    let issuer = parse_url(&options.issuer, "issuer")?;
    if !(issuer.scheme == "https" || (issuer.scheme == "http" && LOOPBACK.contains(&issuer.hostname.as_str()))) {
        return Err(other("issuer must be an https URL (http only for localhost)"));
    }
    if issuer.has_search || issuer.has_hash {
        return Err(other("issuer must have no query or fragment"));
    }
    if let Some(back_channel_url) = &options.back_channel_url {
        let back = parse_url(back_channel_url, "backChannelUrl")?;
        if back.scheme != "https" && back.scheme != "http" {
            return Err(other("backChannelUrl must be an http or https URL"));
        }
        if back.has_search || back.has_hash {
            return Err(other("backChannelUrl must have no query or fragment"));
        }
    }
    if options.client_id.is_empty() {
        return Err(other("clientId is required"));
    }
    parse_url(&options.redirect_uri, "redirectUri")?;
    if options.client_secret.as_deref() == Some("") {
        return Err(other("clientSecret must be a non-empty string when set"));
    }
    if options.audience.as_deref() == Some("") {
        return Err(other("audience must be a non-empty string when set"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

impl Inner {
    fn now(&self) -> f64 {
        (self.now)()
    }

    /// The same endpoint on the private-network URL, when one is configured
    /// and the endpoint is the issuer's own.
    fn via_back_channel(&self, endpoint: &str) -> String {
        if let Some(back_base) = &self.back_base {
            let under_issuer = endpoint.strip_prefix(self.issuer_base.as_str()).filter(|rest| rest.is_empty() || rest.starts_with('/'));
            if let Some(rest) = under_issuer {
                return format!("{back_base}{rest}");
            }
        }
        endpoint.to_string()
    }

    async fn load_discovery(&self) -> Result<Arc<Obj>, AuthError> {
        let url = self.via_back_channel(&format!("{}/.well-known/openid-configuration", self.issuer_base));
        let response = call(http().get(url).header("Accept", "application/json")).await?;
        let status = response.status().as_u16();
        if !is_ok(status) {
            return Err(unavailable(format!("discovery answered {status}")));
        }
        let document = read_json(response).await?;
        // OIDC Discovery §4.3: a document naming another issuer is refused.
        if document.get("issuer").and_then(Json::as_str) != Some(self.issuer.as_str()) {
            return Err(other("the discovery document names a different issuer"));
        }
        for field in ["authorization_endpoint", "token_endpoint", "jwks_uri"] {
            if !document.get(field).map(Json::is_string).unwrap_or(false) {
                return Err(other(format!("the discovery document has no {field}")));
            }
        }
        Ok(Arc::new(document))
    }

    /// The provider's discovery document: loaded once, by whoever asks first,
    /// and asked for again only after a load that failed.
    fn discover(self: &Arc<Self>) -> Pending<Arc<Obj>> {
        let mut slot = self.discovery.lock().unwrap();
        if let Some((_, pending)) = slot.as_ref() {
            return pending.clone();
        }
        let load = self.discovery_loads.fetch_add(1, Ordering::Relaxed);
        let inner = self.clone();
        let pending = detached(async move {
            let result = inner.load_discovery().await;
            if result.is_err() {
                let mut slot = inner.discovery.lock().unwrap();
                if slot.as_ref().map(|(current, _)| *current == load).unwrap_or(false) {
                    *slot = None;
                }
            }
            result
        });
        *slot = Some((load, pending.clone()));
        pending
    }

    /// The text of a discovery field `load_discovery` checked is a string.
    fn required_endpoint(discovery: &Obj, field: &str) -> String {
        discovery.get(field).and_then(Json::as_str).unwrap_or_default().to_string()
    }

    async fn post(&self, endpoint: &str, params: &[(&str, &str)], extra: &[(&str, &str)]) -> Result<reqwest::Response, AuthError> {
        let mut form: Vec<(&str, &str)> = params.to_vec();
        let mut request = http()
            .post(self.via_back_channel(endpoint))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Accept", "application/json");
        for (name, value) in extra {
            request = request.header(*name, *value);
        }
        match &self.client_secret {
            // A public client names itself in the body.
            None => form.push(("client_id", &self.client_id)),
            Some(client_secret) => {
                // RFC 6749 §2.3.1: each part is form-encoded before Basic encoding.
                let pair = format!("{}:{}", form_encode(&self.client_id), form_encode(client_secret));
                let encoded = base64::engine::general_purpose::STANDARD.encode(pair);
                request = request.header("Authorization", format!("Basic {encoded}"));
            }
        }
        let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(form).finish();
        call(request.body(body)).await
    }

    async fn token_request(self: &Arc<Self>, params: &[(&str, &str)]) -> Result<Obj, AuthError> {
        let discovery = self.discover().await?;
        let response = self.post(&Self::required_endpoint(&discovery, "token_endpoint"), params, &[]).await?;
        let status = response.status().as_u16();
        let answer = read_json(response).await?;
        if is_ok(status) {
            return Ok(answer);
        }
        if answer.get("error").and_then(Json::as_str) == Some("invalid_grant") {
            return Err(AuthError::InvalidGrant("the provider refused the grant".into()));
        }
        if status == 429 {
            return Err(unavailable("the token endpoint is rate limiting this client"));
        }
        Err(other(format!("the token endpoint refused the request ({})", error_code(&answer, status))))
    }

    async fn fetch_keys(self: &Arc<Self>) -> Result<HashMap<String, [u8; 32]>, AuthError> {
        let discovery = self.discover().await?;
        let url = self.via_back_channel(&Self::required_endpoint(&discovery, "jwks_uri"));
        let response = call(http().get(url).header("Accept", "application/json")).await?;
        let status = response.status().as_u16();
        if !is_ok(status) {
            return Err(unavailable(format!("the key set answered {status}")));
        }
        let document = read_json(response).await?;
        let mut next = HashMap::new();
        for jwk in document.get("keys").and_then(Json::as_array).map(Vec::as_slice).unwrap_or_default() {
            if let Some((kid, key)) = import_key(jwk) {
                next.insert(kid, key);
            }
        }
        Ok(next)
    }

    /// Fetches the provider's keys, unless a fetch is under way (it is joined)
    /// or one was tried too recently (`None`: nothing to wait for).
    fn load_keys(self: &Arc<Self>) -> Option<Pending<()>> {
        let mut keys = self.keys.lock().unwrap();
        if let Some(loading) = &keys.loading {
            return Some(loading.clone());
        }
        // Without this floor, tokens with made-up kids could make every request fetch.
        let now = self.now();
        if now - keys.last_attempt < JWKS_MIN_INTERVAL_MS {
            return None;
        }
        keys.last_attempt = now;
        let inner = self.clone();
        let loading = detached(async move {
            let result = inner.fetch_keys().await;
            let mut keys = inner.keys.lock().unwrap();
            keys.loading = None;
            let next = result?;
            keys.by_kid = next;
            keys.fetched_at = inner.now();
            Ok(())
        });
        keys.loading = Some(loading.clone());
        Some(loading)
    }

    async fn key_for(self: &Arc<Self>, kid: &str) -> Result<[u8; 32], AuthError> {
        let stale = {
            let keys = self.keys.lock().unwrap();
            self.now() - keys.fetched_at >= JWKS_TTL_MS || !keys.by_kid.contains_key(kid)
        };
        if stale {
            if let Some(loading) = self.load_keys() {
                match loading.await {
                    // Keep verifying with the keys we have while auth is unreachable.
                    Ok(()) | Err(AuthError::Unavailable(_)) => {}
                    Err(error) => return Err(error),
                }
            }
            if self.keys.lock().unwrap().fetched_at == f64::NEG_INFINITY {
                return Err(unavailable("auth's signing keys are unavailable"));
            }
        }
        self.keys.lock().unwrap().by_kid.get(kid).copied().ok_or_else(|| invalid_token("signed with an unknown key"))
    }

    async fn verify_jwt(self: &Arc<Self>, token: &str, typ: &str, aud: &str, check_exp: bool) -> Result<Obj, AuthError> {
        let parts: Vec<&str> = token.split('.').collect();
        let [h, p, s] = parts[..] else { return Err(invalid_token("not a JWT")) };
        if !parts.iter().all(|part| is_base64url(part)) {
            return Err(invalid_token("not a JWT"));
        }
        let header = parse_segment(h)?;
        let payload = parse_segment(p)?;
        // The algorithm is pinned: the header can only confirm it, never choose it.
        if header.get("alg").and_then(Json::as_str) != Some("EdDSA") {
            return Err(invalid_token("unexpected alg"));
        }
        if header.get("typ").and_then(Json::as_str).map(str::to_lowercase).as_deref() != Some(typ) {
            return Err(invalid_token("unexpected typ"));
        }
        if header.contains_key("crit") {
            return Err(invalid_token("unsupported critical header"));
        }
        let Some(kid) = header.get("kid").and_then(Json::as_str) else { return Err(invalid_token("no kid")) };
        let key = self.key_for(kid).await?;
        let signed = match (<[u8; 64]>::try_from(decode_base64url(s)), VerifyingKey::from_bytes(&key)) {
            (Ok(signature), Ok(key)) => key.verify(format!("{h}.{p}").as_bytes(), &Signature::from_bytes(&signature)).is_ok(),
            _ => false,
        };
        if !signed {
            return Err(invalid_token("bad signature"));
        }
        if payload.get("iss").and_then(Json::as_str) != Some(self.issuer.as_str()) {
            return Err(invalid_token("wrong issuer"));
        }
        let aud_ok = match payload.get("aud") {
            Some(Json::String(single)) => single == aud,
            Some(Json::Array(several)) => several.iter().any(|one| one.as_str() == Some(aud)),
            _ => false,
        };
        if !aud_ok {
            return Err(invalid_token("wrong audience"));
        }
        let t = self.now() / 1000.0;
        let number = |claim: &str| payload.get(claim).filter(|value| value.is_number()).and_then(Json::as_f64);
        if !number("iat").map(|iat| iat <= t + LEEWAY_S).unwrap_or(false) {
            return Err(invalid_token("issued in the future"));
        }
        if check_exp && !number("exp").map(|exp| t <= exp + LEEWAY_S).unwrap_or(false) {
            return Err(invalid_token("expired"));
        }
        Ok(payload)
    }

    async fn verify_access_token(self: &Arc<Self>, jwt: &str) -> Result<AccessClaims, AuthError> {
        let claims = self.verify_jwt(jwt, "at+jwt", &self.audience, true).await?;
        for claim in ["sub", "sid", "username", "name", "role"] {
            if !claims.get(claim).map(Json::is_string).unwrap_or(false) {
                return Err(invalid_token(format!("no {claim} claim")));
            }
        }
        Ok(claims)
    }

    fn forget(&self, sub: Option<&str>, id: Option<&str>) {
        if sub.is_none() && id.is_none() {
            return;
        }
        self.cache.lock().unwrap().retain(|_, cached| {
            let same_sub = sub.map(|sub| cached.answer.sub == sub).unwrap_or(false);
            let same_id = id.map(|id| cached.answer.id.as_deref() == Some(id)).unwrap_or(false);
            !(same_sub || same_id)
        });
    }

    /// Asks the provider about `secret`; `Ok(None)` is its 429.
    async fn ask_introspection(self: &Arc<Self>, secret: &str, ip: Option<&str>) -> Result<Option<(u16, Obj)>, AuthError> {
        let discovery = self.discover().await?;
        let Some(endpoint) = optional_endpoint(&discovery, "introspection_endpoint") else {
            return Err(other("the provider has no introspection endpoint"));
        };
        let extra: Vec<(&str, &str)> = ip.filter(|ip| !ip.is_empty()).map(|ip| ("X-Real-IP", ip)).into_iter().collect();
        let response = self.post(posted_endpoint(endpoint)?, &[("token", secret)], &extra).await?;
        let status = response.status().as_u16();
        if status == 429 {
            return Ok(None);
        }
        Ok(Some((status, read_json(response).await?)))
    }

    async fn introspect(self: &Arc<Self>, secret: &str, ip: Option<&str>) -> Result<Option<Introspection>, AuthError> {
        if self.client_secret.is_none() {
            return Err(other("introspection needs a confidential client"));
        }
        if ip.map(|ip| !is_ip(ip)).unwrap_or(false) {
            return Err(other("ip must be an IP address"));
        }
        // Keyed by digest, so the cache never holds a usable secret.
        let key = hex::encode(Sha256::digest(secret.as_bytes()));
        let hit = self.cache.lock().unwrap().get(&key).map(|cached| (cached.answer.clone(), cached.at));
        if let Some((answer, at)) = &hit {
            if self.now() - at < FRESH_MS {
                return Ok(Some(answer.clone()));
            }
        }
        let asked = match self.ask_introspection(secret, ip).await {
            Ok(asked) => asked,
            Err(error) => {
                if let (AuthError::Unavailable(_), Some((answer, at))) = (&error, hit) {
                    if self.now() - at < STALE_MS {
                        return Ok(Some(answer));
                    }
                }
                return Err(error);
            }
        };
        let Some((status, answer)) = asked else { return Ok(None) };
        if !is_ok(status) {
            return Err(other(format!("introspection refused the request ({})", error_code(&answer, status))));
        }
        if answer.get("active") != Some(&Json::Bool(true)) {
            self.cache.lock().unwrap().shift_remove(&key);
            return Ok(None);
        }
        let text = |field: &str| answer.get(field).and_then(Json::as_str).map(str::to_string);
        let (Some(sub), Some(username), Some(role)) = (text("sub"), text("username"), text("role")) else {
            return Err(unavailable("introspection answered without sub, username or role"));
        };
        let result = Introspection {
            sub,
            username,
            role,
            scopes: text("scope")
                .map(|scope| scope.split(' ').filter(|part| !part.is_empty()).map(str::to_string).collect())
                .unwrap_or_default(),
            id: text("jti"),
        };
        remember(&mut self.cache.lock().unwrap(), key, CachedIntrospection { answer: result.clone(), at: self.now() }, CACHE_MAX);
        Ok(Some(result))
    }

    async fn read_event(self: &Arc<Self>, body: &str) -> Result<AuthEvent, AuthError> {
        let set = self.verify_jwt(js_trim(body), "secevent+jwt", &self.audience, false).await?;
        let Some(jti) = set.get("jti").and_then(Json::as_str).filter(|jti| !jti.is_empty()) else {
            return Err(invalid_token("no jti"));
        };
        let events = set.get("events").and_then(Json::as_object);
        let (event_type, payload) = match events.map(|events| (events.len(), events.iter().next())) {
            Some((1, Some(only))) => only,
            _ => return Err(invalid_token("a SET carries exactly one event")),
        };
        let Some(payload) = payload.as_object() else { return Err(invalid_token("malformed event payload")) };
        let mut event = AuthEvent { event_type: event_type.clone(), jti: jti.to_string(), ..Default::default() };
        let Some(required) = event_fields(event_type) else {
            if OBJECT_PROTOTYPE_MEMBERS.contains(&event_type.as_str()) {
                return Err(other("{} is not iterable"));
            }
            return Ok(event);
        };
        for field in required {
            let Some(value) = payload.get(*field).and_then(Json::as_str) else {
                return Err(invalid_token(format!("{event_type} without {field}")));
            };
            let slot = match *field {
                "sub" => &mut event.sub,
                "sid" => &mut event.sid,
                "id" => &mut event.id,
                _ => &mut event.invite,
            };
            *slot = Some(value.to_string());
        }
        if event_type == "access.changed" {
            event.role = match payload.get("role") {
                Some(Json::Null) => Some(None),
                Some(Json::String(role)) => Some(Some(role.clone())),
                _ => return Err(invalid_token("access.changed without role")),
            };
        }
        match event_type.as_str() {
            "credential.revoked" => self.forget(None, event.id.as_deref()),
            "access.changed" | "user.disabled" | "user.deleted" => self.forget(event.sub.as_deref(), None),
            _ => {}
        }
        Ok(event)
    }
}

impl AuthClient {
    pub fn new(options: AuthClientOptions) -> Result<Self, AuthError> {
        Self::with_clock(options, Box::new(JsDate::now_ms))
    }

    /// `now` stands in for the clock, in milliseconds since the epoch.
    fn with_clock(options: AuthClientOptions, now: Clock) -> Result<Self, AuthError> {
        check_options(&options)?;
        let audience = options.audience.unwrap_or_else(|| options.client_id.clone());
        let inner = Inner {
            issuer_base: options.issuer.trim_end_matches('/').to_string(),
            back_base: options.back_channel_url.map(|url| url.trim_end_matches('/').to_string()),
            issuer: options.issuer,
            client_id: options.client_id,
            client_secret: options.client_secret,
            redirect_uri: options.redirect_uri,
            audience,
            now,
            discovery: Mutex::new(None),
            discovery_loads: AtomicU64::new(0),
            keys: Mutex::new(Keys {
                by_kid: HashMap::new(),
                fetched_at: f64::NEG_INFINITY,
                last_attempt: f64::NEG_INFINITY,
                loading: None,
            }),
            cache: Mutex::new(IndexMap::new()),
        };
        Ok(AuthClient { inner: Arc::new(inner) })
    }

    /// Where to send the browser to sign in, and the cookie that carries the
    /// sign-in to the callback.
    pub async fn start_login(&self, options: StartLoginOptions) -> Result<StartedLogin, AuthError> {
        let inner = &self.inner;
        let discovery = inner.discover().await?;
        let state = random();
        let nonce = random();
        let verifier = random();
        let mut url = endpoint_url(&Inner::required_endpoint(&discovery, "authorization_endpoint"))?;
        let mut params: Vec<(&str, String)> = vec![
            ("response_type", "code".to_string()),
            ("client_id", inner.client_id.clone()),
            ("redirect_uri", inner.redirect_uri.clone()),
            ("scope", "openid profile email".to_string()),
            ("state", state.clone()),
            ("nonce", nonce.clone()),
            ("code_challenge", encode_base64url(Sha256::digest(verifier.as_bytes()))),
            ("code_challenge_method", "S256".to_string()),
        ];
        if let Some(prompt) = &options.prompt {
            if prompt != "none" && prompt != "login" {
                return Err(other("prompt must be none or login"));
            }
            params.push(("prompt", prompt.clone()));
        }
        if let Some(max_age) = options.max_age {
            if max_age < 0 || max_age as f64 > crate::js::MAX_SAFE_INTEGER {
                return Err(other("maxAge must be a whole number of seconds"));
            }
            params.push(("max_age", max_age.to_string()));
        }
        if let Some(login_hint) = &options.login_hint {
            params.push(("login_hint", login_hint.clone()));
        }
        set_search_params(&mut url, &params);
        let return_to = options.return_to.as_deref().filter(|path| is_local_path(path)).unwrap_or("/");
        // What was asked of the sign-in travels with the cookie: the browser
        // carries the request and can drop max_age or prompt from it, so the
        // ID token's auth_time is checked against them at the callback.
        let mut login = Obj::new();
        login.insert("state".into(), json!(state));
        login.insert("nonce".into(), json!(nonce));
        login.insert("verifier".into(), json!(verifier));
        login.insert("returnTo".into(), json!(return_to));
        login.insert("iat".into(), num((inner.now() / 1000.0).floor()));
        if let Some(max_age) = options.max_age {
            login.insert("maxAge".into(), json!(max_age));
        }
        login.insert("fresh".into(), json!(options.prompt.as_deref() == Some("login")));
        let value = encode_base64url(json_stringify(&Json::Object(login)));
        Ok(StartedLogin {
            redirect_url: url.to_string(),
            login_cookie: format!("{LOGIN_COOKIE}={value}; {COOKIE_ATTRIBUTES}; Max-Age={LOGIN_TTL_S}"),
        })
    }

    /// Completes the sign-in the callback request carries: checks it against
    /// the login cookie, exchanges the code, and verifies both tokens.
    pub async fn finish_login(&self, request: IncomingRequest<'_>) -> Result<Login, AuthError> {
        let inner = &self.inner;
        let saved = match read_cookie(request.cookie, LOGIN_COOKIE).filter(|raw| is_base64url(raw)) {
            Some(raw) => parse_segment(raw)?,
            None => Obj::new(),
        };
        let text = |field: &str| saved.get(field).and_then(Json::as_str);
        let number = |field: &str| saved.get(field).filter(|value| value.is_number()).and_then(Json::as_f64);
        let (Some(state), Some(nonce), Some(verifier), Some(iat)) = (text("state"), text("nonce"), text("verifier"), number("iat")) else {
            return Err(login_error("no_login_cookie"));
        };
        let t = inner.now() / 1000.0;
        if t - iat > f64::from(LOGIN_TTL_S) || iat > t + LEEWAY_S {
            return Err(login_error("login_expired"));
        }
        let query: Vec<(String, String)> =
            Url::parse(request.url).map(|url| url.query_pairs().into_owned().collect()).unwrap_or_default();
        let param = |name: &str| query.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
        if let Some(error) = param("error") {
            return Err(AuthError::Login { code: "authorization_error", error: Some(js_slice_start(error, 64)) });
        }
        if !same_digest(param("state").unwrap_or(""), state) {
            return Err(login_error("state_mismatch"));
        }
        let Some(code) = param("code").filter(|code| !code.is_empty()) else { return Err(login_error("missing_code")) };
        let answer = inner
            .token_request(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", &inner.redirect_uri),
                ("code_verifier", verifier),
            ])
            .await?;
        let (Some(access_token), Some(id_token)) =
            (answer.get("access_token").and_then(Json::as_str), answer.get("id_token").and_then(Json::as_str))
        else {
            return Err(unavailable("the token endpoint answered without an access token or ID token"));
        };
        let claims = inner.verify_access_token(access_token).await?;
        let id_claims = inner.verify_jwt(id_token, "jwt", &inner.client_id, true).await?;
        let several_audiences = id_claims.get("aud").and_then(Json::as_array).map(|aud| aud.len() > 1).unwrap_or(false);
        if several_audiences && id_claims.get("azp").and_then(Json::as_str) != Some(inner.client_id.as_str()) {
            return Err(invalid_token("wrong authorized party"));
        }
        if !id_claims.get("nonce").and_then(Json::as_str).map(|theirs| same_digest(theirs, nonce)).unwrap_or(false) {
            return Err(invalid_token("nonce mismatch"));
        }
        if id_claims.get("sub") != claims.get("sub") {
            return Err(invalid_token("the ID token names another subject"));
        }
        // OIDC Core §3.1.3.7: with max_age or prompt=login, the sign-in must be
        // as recent as asked, whatever the authorization request ended up as.
        let max_age = number("maxAge");
        let fresh = saved.get("fresh") == Some(&Json::Bool(true));
        if max_age.is_some() || fresh {
            let Some(auth_time) = id_claims.get("auth_time").filter(|value| value.is_number()).and_then(Json::as_f64) else {
                return Err(invalid_token("no auth_time"));
            };
            if max_age.map(|max_age| t - auth_time > max_age + LEEWAY_S).unwrap_or(false) {
                return Err(invalid_token("the sign-in is older than max_age"));
            }
            if fresh && auth_time < iat - LEEWAY_S {
                return Err(invalid_token("the sign-in is older than the login request"));
            }
        }
        Ok(Login {
            access_token: access_token.to_string(),
            refresh_token: answer.get("refresh_token").and_then(Json::as_str).map(str::to_string),
            return_to: text("returnTo").filter(|path| is_local_path(path)).unwrap_or("/").to_string(),
            clear_cookie: format!("{LOGIN_COOKIE}=; {COOKIE_ATTRIBUTES}; Max-Age=0"),
            claims,
            id_claims,
        })
    }

    /// Trades a refresh token for a new access token: how a session asks
    /// whether its sign-in still stands.
    pub async fn refresh(&self, refresh_token: &str) -> Result<Refreshed, AuthError> {
        let inner = &self.inner;
        let answer = inner.token_request(&[("grant_type", "refresh_token"), ("refresh_token", refresh_token)]).await?;
        let Some(access_token) = answer.get("access_token").and_then(Json::as_str) else {
            return Err(unavailable("the token endpoint answered without an access token"));
        };
        let claims = inner.verify_access_token(access_token).await?;
        Ok(Refreshed {
            claims,
            access_token: access_token.to_string(),
            refresh_token: answer.get("refresh_token").and_then(Json::as_str).map(str::to_string),
        })
    }

    /// Who an API key or app password the provider issued belongs to, or
    /// `None` when it is not active (or the provider is rate limiting us).
    /// Answers are served from memory for a minute, and for ten while the
    /// provider cannot be reached.
    pub async fn introspect(&self, secret: &str, ip: Option<&str>) -> Result<Option<Introspection>, AuthError> {
        self.inner.introspect(secret, ip).await
    }

    /// Drops the cached introspection answers of a person or of one credential.
    pub fn forget(&self, sub: Option<&str>, id: Option<&str>) {
        self.inner.forget(sub, id);
    }

    pub async fn revoke(&self, refresh_token: &str) -> Result<(), AuthError> {
        let inner = &self.inner;
        let discovery = inner.discover().await?;
        let Some(endpoint) = optional_endpoint(&discovery, "revocation_endpoint") else {
            return Err(other("the provider has no revocation endpoint"));
        };
        let params = [("token", refresh_token), ("token_type_hint", "refresh_token")];
        let response = inner.post(posted_endpoint(endpoint)?, &params, &[]).await?;
        let status = response.status().as_u16();
        if !is_ok(status) {
            return Err(other(format!("revocation refused the request ({status})")));
        }
        Ok(())
    }

    /// Verifies a security event token and returns the one event it carries.
    pub async fn read_event(&self, body: &str) -> Result<AuthEvent, AuthError> {
        self.inner.read_event(body).await
    }

    /// Where the browser goes to sign out of the identity provider too.
    pub async fn logout_url(&self, post_logout_redirect: Option<&str>) -> Result<String, AuthError> {
        let inner = &self.inner;
        let discovery = inner.discover().await?;
        let Some(endpoint) = optional_endpoint(&discovery, "end_session_endpoint") else {
            return Err(other("the provider has no end_session_endpoint"));
        };
        let mut url = endpoint_url(&to_js_string(endpoint))?;
        let mut params = vec![("client_id", inner.client_id.clone())];
        if let Some(post_logout_redirect) = post_logout_redirect {
            params.push(("post_logout_redirect_uri", post_logout_redirect.to_string()));
        }
        set_search_params(&mut url, &params);
        Ok(url.to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;

    use ed25519_dalek::{Signer, SigningKey};
    use http_body_util::{BodyExt, Full};
    use hyper::service::service_fn;
    use hyper_util::rt::TokioIo;

    use super::*;

    // -- Pure pieces --------------------------------------------------------

    #[test]
    fn base64url_is_read_leniently() {
        assert_eq!(decode_base64url("aGVsbG8"), b"hello");
        assert_eq!(decode_base64url("aGVsbG8="), b"hello");
        // Either alphabet, characters outside it skipped, a dangling character dropped.
        assert_eq!(decode_base64url("ab+/"), decode_base64url("ab-_"));
        assert_eq!(decode_base64url("a.b"), decode_base64url("ab"));
        assert_eq!(decode_base64url("abcde"), decode_base64url("abcd"));
        assert_eq!(decode_base64url("a"), b"");
        assert_eq!(decode_base64url(""), b"");
        assert_eq!(decode_base64url("ab=c"), decode_base64url("ab"));
    }

    #[test]
    fn segments_must_be_json_objects() {
        assert!(parse_segment(&encode_base64url(r#"{"a":1}"#)).is_ok());
        for not_an_object in ["[1]", "\"text\"", "5", "null", "nope", ""] {
            assert_eq!(parse_segment(&encode_base64url(not_an_object)), Err(invalid_token("malformed segment")));
        }
    }

    #[test]
    fn the_first_cookie_of_the_name_is_read() {
        assert_eq!(read_cookie(Some("a=1; __Host-login=abc; __Host-login=def"), "__Host-login"), Some("abc"));
        assert_eq!(read_cookie(Some(" __Host-login = abc "), "__Host-login"), Some("abc"));
        assert_eq!(read_cookie(Some("__Host-login=a=b"), "__Host-login"), Some("a=b"));
        assert_eq!(read_cookie(Some("__Host-login"), "__Host-login"), None);
        assert_eq!(read_cookie(Some("=abc"), ""), None);
        assert_eq!(read_cookie(None, "__Host-login"), None);
    }

    #[test]
    fn only_a_path_on_this_origin_is_local() {
        for local in ["/", "/budgets", "/a?next=https://evil.example/#x", "/%2F%2Fevil.example", "/é", "/a\"b"] {
            assert!(is_local_path(local), "{local}");
        }
        for foreign in ["", "budgets", "//evil.example", "https://evil.example", "/\\evil.example", "/a b", "/a\tb", "/a\nb", "/a\u{7f}b", "/a\\b"] {
            assert!(!is_local_path(foreign), "{foreign}");
        }
        assert!(is_local_path(&format!("/{}", "a".repeat(2047))));
        assert!(!is_local_path(&format!("/{}", "a".repeat(2048))));
        // The limit counts UTF-16 units.
        assert!(!is_local_path(&format!("/{}", "🔑".repeat(1024))));
    }

    #[test]
    fn credentials_are_form_encoded() {
        assert_eq!(form_encode("a b+c/d:é~!*'()"), "a+b%2Bc%2Fd%3A%C3%A9~!*'()");
    }

    #[test]
    fn an_error_code_is_quoted_only_when_it_is_one() {
        let answer = |error: Json| json!({ "error": error }).as_object().cloned().unwrap();
        assert_eq!(error_code(&answer(json!("invalid_client")), 401), "invalid_client");
        assert_eq!(error_code(&answer(json!("a.b-c_1")), 400), "a.b-c_1");
        assert_eq!(error_code(&answer(json!("no such code!")), 400), "400");
        assert_eq!(error_code(&answer(json!("")), 400), "400");
        assert_eq!(error_code(&answer(json!("x".repeat(65))), 418), "418");
        assert_eq!(error_code(&answer(json!(5)), 403), "403");
        assert_eq!(error_code(&Obj::new(), 500), "500");
    }

    #[test]
    fn search_params_are_set_like_url_search_params() {
        let mut url = Url::parse("https://auth.example.com/authorize?tenant=a%20b&client_id=old&scope=x&flag&scope=y#top").unwrap();
        set_search_params(&mut url, &[("client_id", "bud get".to_string()), ("scope", "openid profile".to_string()), ("state", "~!*'()".to_string())]);
        assert_eq!(
            url.as_str(),
            "https://auth.example.com/authorize?tenant=a+b&client_id=bud+get&scope=openid+profile&flag=&state=%7E%21*%27%28%29#top"
        );
    }

    #[test]
    fn only_ed25519_signing_keys_are_imported() {
        let x = encode_base64url([7u8; 32]);
        let jwk = |change: Json| {
            let mut jwk = json!({ "kty": "OKP", "crv": "Ed25519", "x": x, "kid": "k1" });
            for (name, value) in change.as_object().unwrap() {
                jwk[name] = value.clone();
            }
            jwk
        };
        assert_eq!(import_key(&jwk(json!({}))), Some(("k1".to_string(), [7u8; 32])));
        assert!(import_key(&jwk(json!({ "use": "sig", "alg": "EdDSA", "extra": true }))).is_some());
        for change in [
            json!({ "kty": "RSA" }),
            json!({ "crv": "X25519" }),
            json!({ "use": "enc" }),
            json!({ "use": null }),
            json!({ "alg": "ES256" }),
            json!({ "kid": 1 }),
            json!({ "x": 5 }),
            json!({ "x": encode_base64url([7u8; 31]) }),
            json!({ "x": encode_base64url([7u8; 33]) }),
        ] {
            assert_eq!(import_key(&jwk(change.clone())), None, "{change}");
        }
        assert_eq!(import_key(&json!("k1")), None);
        assert_eq!(import_key(&Json::Null), None);
    }

    #[test]
    fn the_cache_drops_its_oldest_answer_past_its_limit() {
        let entry = |sub: &str, at: f64| CachedIntrospection {
            answer: Introspection { sub: sub.into(), username: sub.into(), role: "user".into(), scopes: vec![], id: None },
            at,
        };
        let mut cache = IndexMap::new();
        for (key, at) in [("a", 1.0), ("b", 2.0), ("c", 3.0)] {
            remember(&mut cache, key.to_string(), entry(key, at), 3);
        }
        // Asked about again, an answer becomes the youngest.
        remember(&mut cache, "a".to_string(), entry("a", 4.0), 3);
        assert_eq!(cache.keys().collect::<Vec<_>>(), ["b", "c", "a"]);
        remember(&mut cache, "d".to_string(), entry("d", 5.0), 3);
        assert_eq!(cache.keys().collect::<Vec<_>>(), ["c", "a", "d"]);
        assert_eq!(cache["a"].at, 4.0);
    }

    fn options(issuer: &str) -> AuthClientOptions {
        AuthClientOptions {
            issuer: issuer.to_string(),
            back_channel_url: None,
            client_id: "budget".to_string(),
            client_secret: Some("s3cret".to_string()),
            redirect_uri: "https://budget.example.com/api/auth/callback".to_string(),
            audience: None,
        }
    }

    fn refusal(options: AuthClientOptions) -> String {
        AuthClient::new(options).err().map(|error| error.to_string()).unwrap_or_default()
    }

    #[test]
    fn options_are_checked_when_the_client_is_made() {
        let valid = || options("https://auth.example.com");
        assert!(AuthClient::new(valid()).is_ok());
        for issuer in ["http://localhost:4000", "http://127.0.0.1:4000", "http://[::1]:4000", "https://auth.example.com/tenant/"] {
            assert!(AuthClient::new(options(issuer)).is_ok(), "{issuer}");
        }
        assert_eq!(refusal(options("")), "issuer is required");
        assert_eq!(refusal(options("auth.example.com")), "issuer must be an absolute URL");
        assert_eq!(refusal(options("http://auth.example.com")), "issuer must be an https URL (http only for localhost)");
        assert_eq!(refusal(options("https://auth.example.com/?x=1")), "issuer must have no query or fragment");
        assert_eq!(refusal(options("https://auth.example.com/#x")), "issuer must have no query or fragment");
        let with = |change: fn(&mut AuthClientOptions)| {
            let mut options = valid();
            change(&mut options);
            refusal(options)
        };
        assert_eq!(with(|o| o.back_channel_url = Some("".into())), "backChannelUrl is required");
        assert_eq!(with(|o| o.back_channel_url = Some("auth.internal".into())), "backChannelUrl must be an absolute URL");
        assert_eq!(with(|o| o.back_channel_url = Some("ftp://auth.internal".into())), "backChannelUrl must be an http or https URL");
        // A bare `?` or `#` is an empty query or fragment, which is none.
        assert_eq!(with(|o| o.back_channel_url = Some("http://auth.internal/?#".into())), "");
        assert_eq!(with(|o| o.back_channel_url = Some("http://auth.internal/?x=1".into())), "backChannelUrl must have no query or fragment");
        assert_eq!(with(|o| o.client_id = String::new()), "clientId is required");
        assert_eq!(with(|o| o.redirect_uri = String::new()), "redirectUri is required");
        assert_eq!(with(|o| o.redirect_uri = "/api/auth/callback".into()), "redirectUri must be an absolute URL");
        assert_eq!(with(|o| o.client_secret = Some(String::new())), "clientSecret must be a non-empty string when set");
        assert_eq!(with(|o| o.audience = Some(String::new())), "audience must be a non-empty string when set");
    }

    #[test]
    fn only_the_issuers_own_endpoints_go_over_the_back_channel() {
        let client = AuthClient::new(AuthClientOptions {
            back_channel_url: Some("http://auth.internal:3000/".to_string()),
            ..options("https://auth.example.com/")
        })
        .unwrap();
        let via = |endpoint: &str| client.inner.via_back_channel(endpoint);
        assert_eq!(via("https://auth.example.com/oauth/token"), "http://auth.internal:3000/oauth/token");
        assert_eq!(via("https://auth.example.com"), "http://auth.internal:3000");
        assert_eq!(via("https://auth.example.com/"), "http://auth.internal:3000/");
        assert_eq!(via("https://auth.example.com.evil.example/oauth/token"), "https://auth.example.com.evil.example/oauth/token");
        assert_eq!(via("https://tokens.example.com/oauth/token"), "https://tokens.example.com/oauth/token");
        // With no back channel, every endpoint is called where it is.
        let direct = AuthClient::new(options("https://auth.example.com")).unwrap();
        assert_eq!(direct.inner.via_back_channel("https://auth.example.com/oauth/token"), "https://auth.example.com/oauth/token");
    }

    // -- A provider to talk to ---------------------------------------------

    /// How the provider answers one request: a status and a body.
    type Answer = Box<dyn Fn(&str, &str) -> (u16, String) + Send + Sync>;

    struct Provider {
        issuer: String,
        /// `METHOD path` of every request so far.
        requests: Arc<Mutex<Vec<String>>>,
        answer: Arc<Mutex<Answer>>,
        now: Arc<AtomicU64>,
        signing: SigningKey,
    }

    impl Provider {
        async fn start() -> Provider {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let issuer = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
            let requests: Arc<Mutex<Vec<String>>> = Arc::default();
            let answer: Arc<Mutex<Answer>> = Arc::new(Mutex::new(Box::new(|_, _| (404, "{}".to_string()))));
            let (seen, answers) = (requests.clone(), answer.clone());
            tokio::spawn(async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else { return };
                    let (seen, answers) = (seen.clone(), answers.clone());
                    tokio::spawn(async move {
                        let service = service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                            let (seen, answers) = (seen.clone(), answers.clone());
                            async move {
                                let path = request.uri().path().to_string();
                                let line = format!("{} {}", request.method(), path);
                                let body = request.into_body().collect().await.map(|body| body.to_bytes()).unwrap_or_default();
                                seen.lock().unwrap().push(line);
                                let (status, text) = (answers.lock().unwrap())(&path, &String::from_utf8_lossy(&body));
                                let mut response = hyper::Response::new(Full::new(bytes::Bytes::from(text)));
                                *response.status_mut() = hyper::StatusCode::from_u16(status).unwrap();
                                Ok::<_, Infallible>(response)
                            }
                        });
                        let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
                    });
                }
            });
            let provider = Provider {
                issuer,
                requests,
                answer,
                now: Arc::new(AtomicU64::new(1_800_000_000_000)),
                signing: SigningKey::from_bytes(&[7u8; 32]),
            };
            provider.answer_with(&["k1"], |_| None);
            provider
        }

        fn discovery(&self) -> String {
            let at = |path: &str| format!("{}{path}", self.issuer);
            json!({
                "issuer": self.issuer,
                "authorization_endpoint": at("/oauth/authorize"),
                "token_endpoint": at("/oauth/token"),
                "introspection_endpoint": at("/oauth/introspect"),
                "jwks_uri": at("/jwks"),
            })
            .to_string()
        }

        /// Publishes the signing key under `kids`, and answers every other path with `other`, or 404.
        fn answer_with(&self, kids: &[&str], other: impl Fn(&str) -> Option<(u16, String)> + Send + Sync + 'static) {
            let discovery = self.discovery();
            let x = encode_base64url(self.signing.verifying_key().to_bytes());
            let keys: Vec<Json> = kids.iter().map(|kid| json!({ "kty": "OKP", "crv": "Ed25519", "x": x, "kid": kid })).collect();
            let jwks = json!({ "keys": keys }).to_string();
            *self.answer.lock().unwrap() = Box::new(move |path, _body| match path {
                "/.well-known/openid-configuration" => (200, discovery.clone()),
                "/jwks" => (200, jwks.clone()),
                _ => other(path).unwrap_or((404, "{}".to_string())),
            });
        }

        /// Every request is answered 503.
        fn go_down(&self) {
            *self.answer.lock().unwrap() = Box::new(|_, _| (503, String::new()));
        }

        fn client(&self) -> AuthClient {
            let now = self.now.clone();
            AuthClient::with_clock(options(&self.issuer), Box::new(move || now.load(Ordering::SeqCst) as f64)).unwrap()
        }

        fn advance(&self, ms: u64) {
            self.now.fetch_add(ms, Ordering::SeqCst);
        }

        fn count(&self, line: &str) -> usize {
            self.requests.lock().unwrap().iter().filter(|seen| seen.as_str() == line).count()
        }

        /// A security event token signed under `kid`, issued now.
        fn event_token(&self, kid: &str) -> String {
            let header = encode_base64url(json!({ "alg": "EdDSA", "typ": "secevent+jwt", "kid": kid }).to_string());
            let payload = encode_base64url(
                json!({
                    "iss": self.issuer,
                    "aud": "budget",
                    "iat": self.now.load(Ordering::SeqCst) / 1000,
                    "jti": "evt_1",
                    "events": { "session.ended": { "sid": "ses_1" } },
                })
                .to_string(),
            );
            let signature = self.signing.sign(format!("{header}.{payload}").as_bytes());
            format!("{header}.{payload}.{}", encode_base64url(signature.to_bytes()))
        }
    }

    const DISCOVERY: &str = "GET /.well-known/openid-configuration";
    const JWKS: &str = "GET /jwks";
    const INTROSPECT: &str = "POST /oauth/introspect";

    #[tokio::test]
    async fn discovery_is_read_once_and_asked_for_again_only_after_a_failure() {
        let provider = Provider::start().await;
        let client = provider.client();
        provider.go_down();
        assert_eq!(client.start_login(StartLoginOptions::default()).await.err(), Some(unavailable("auth answered 503")));
        assert_eq!(client.logout_url(None).await.err(), Some(unavailable("auth answered 503")));
        assert_eq!(provider.count(DISCOVERY), 2);

        provider.answer_with(&["k1"], |_| None);
        let started = client.start_login(StartLoginOptions::default()).await.unwrap();
        assert!(started.redirect_url.starts_with(&format!("{}/oauth/authorize?response_type=code&client_id=budget&", provider.issuer)));
        assert!(started.login_cookie.starts_with("__Host-login="));
        assert!(started.login_cookie.ends_with("; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300"));
        assert_eq!(provider.count(DISCOVERY), 3);

        // Read, it is kept, provider up or down.
        provider.go_down();
        for _ in 0..3 {
            assert!(client.start_login(StartLoginOptions::default()).await.is_ok());
        }
        assert_eq!(provider.count(DISCOVERY), 3);
        // This provider names no end-session endpoint.
        assert_eq!(client.logout_url(None).await.err(), Some(other("the provider has no end_session_endpoint")));
    }

    #[tokio::test]
    async fn requests_that_arrive_together_share_one_discovery() {
        let provider = Provider::start().await;
        let client = provider.client();
        let (first, second, third) = tokio::join!(
            client.start_login(StartLoginOptions::default()),
            client.start_login(StartLoginOptions::default()),
            client.start_login(StartLoginOptions::default()),
        );
        assert!(first.is_ok() && second.is_ok() && third.is_ok());
        assert_eq!(provider.count(DISCOVERY), 1);
    }

    #[tokio::test]
    async fn keys_are_fetched_on_need_at_most_every_thirty_seconds_and_again_after_an_hour() {
        let provider = Provider::start().await;
        let client = provider.client();
        assert_eq!(provider.count(JWKS), 0);
        assert!(client.read_event(&provider.event_token("k1")).await.is_ok());
        assert!(client.read_event(&provider.event_token("k1")).await.is_ok());
        assert_eq!(provider.count(JWKS), 1);

        // The provider rotates to a new key id. Until thirty seconds have
        // passed since the last fetch, an unknown id does not cause another.
        provider.answer_with(&["k1", "k2"], |_| None);
        provider.advance(29_000);
        assert_eq!(client.read_event(&provider.event_token("k2")).await.err(), Some(invalid_token("signed with an unknown key")));
        assert_eq!(provider.count(JWKS), 1);
        provider.advance(1_000);
        assert!(client.read_event(&provider.event_token("k2")).await.is_ok());
        assert_eq!(provider.count(JWKS), 2);
        // An id nobody published is fetched for once per interval, and refused.
        assert_eq!(client.read_event(&provider.event_token("k9")).await.err(), Some(invalid_token("signed with an unknown key")));
        assert_eq!(provider.count(JWKS), 2);

        // Known keys are trusted for an hour, then read again.
        provider.advance(3_599_000);
        assert!(client.read_event(&provider.event_token("k2")).await.is_ok());
        assert_eq!(provider.count(JWKS), 2);
        provider.advance(1_000);
        assert!(client.read_event(&provider.event_token("k2")).await.is_ok());
        assert_eq!(provider.count(JWKS), 3);

        // Past the hour with the provider down: the keys in hand keep verifying.
        provider.advance(3_600_000);
        provider.go_down();
        assert!(client.read_event(&provider.event_token("k2")).await.is_ok());
        assert_eq!(provider.count(JWKS), 4);
        provider.advance(30_000);
        assert!(client.read_event(&provider.event_token("k1")).await.is_ok());
        assert_eq!(provider.count(JWKS), 5);
        // A key the provider withdrew is gone once a fetch succeeds.
        provider.answer_with(&["k2"], |_| None);
        provider.advance(30_000);
        assert_eq!(client.read_event(&provider.event_token("k1")).await.err(), Some(invalid_token("signed with an unknown key")));
        assert_eq!(provider.count(JWKS), 6);
    }

    #[tokio::test]
    async fn without_keys_nothing_verifies_and_the_fetch_is_not_repeated_at_once() {
        let provider = Provider::start().await;
        let client = provider.client();
        provider.go_down();
        let token = provider.event_token("k1");
        assert_eq!(client.read_event(&token).await.err(), Some(unavailable("auth's signing keys are unavailable")));
        provider.answer_with(&["k1"], |_| None);
        assert_eq!(client.read_event(&token).await.err(), Some(unavailable("auth's signing keys are unavailable")));
        assert_eq!(provider.count(JWKS), 0);
        provider.advance(30_000);
        assert!(client.read_event(&provider.event_token("k1")).await.is_ok());
        assert_eq!(provider.count(JWKS), 1);
    }

    fn introspection(active: bool, sub: &str, id: &str) -> Option<(u16, String)> {
        Some((
            200,
            json!({ "active": active, "sub": sub, "username": sub, "role": "user", "scope": "a  b", "jti": id }).to_string(),
        ))
    }

    #[tokio::test]
    async fn an_introspection_answer_is_fresh_for_a_minute_and_usable_for_ten_while_the_provider_is_out() {
        let provider = Provider::start().await;
        let client = provider.client();
        provider.answer_with(&["k1"], |_| introspection(true, "usr_a", "key_a"));

        let answer = client.introspect("secret", None).await.unwrap().unwrap();
        assert_eq!((answer.sub.as_str(), answer.id.as_deref()), ("usr_a", Some("key_a")));
        assert_eq!(answer.scopes, ["a", "b"]);
        provider.advance(59_999);
        assert!(client.introspect("secret", None).await.unwrap().is_some());
        assert_eq!(provider.count(INTROSPECT), 1);

        // A minute old, it is asked about again.
        provider.advance(1);
        assert!(client.introspect("secret", None).await.unwrap().is_some());
        assert_eq!(provider.count(INTROSPECT), 2);

        // The provider goes out: the last answer serves until it is ten minutes old.
        provider.go_down();
        provider.advance(599_999);
        assert_eq!(client.introspect("secret", None).await.unwrap().map(|answer| answer.sub), Some("usr_a".to_string()));
        assert_eq!(provider.count(INTROSPECT), 3);
        provider.advance(1);
        assert_eq!(client.introspect("secret", None).await.err(), Some(unavailable("auth answered 503")));
        // A key never asked about has no answer to fall back on.
        assert_eq!(client.introspect("another", None).await.err(), Some(unavailable("auth answered 503")));
    }

    #[tokio::test]
    async fn an_inactive_answer_or_a_forgotten_one_is_not_served_again() {
        let provider = Provider::start().await;
        let client = provider.client();
        provider.answer_with(&["k1"], |_| introspection(true, "usr_a", "key_a"));
        assert!(client.introspect("first", None).await.unwrap().is_some());
        assert!(client.introspect("second", None).await.unwrap().is_some());
        assert_eq!(provider.count(INTROSPECT), 2);

        // Forgotten by credential id: both secrets carry it here, so both are asked about again.
        client.forget(None, Some("key_other"));
        client.forget(None, None);
        assert!(client.introspect("first", None).await.unwrap().is_some());
        assert_eq!(provider.count(INTROSPECT), 2);
        client.forget(None, Some("key_a"));
        assert!(client.introspect("first", None).await.unwrap().is_some());
        assert_eq!(provider.count(INTROSPECT), 3);
        client.forget(Some("usr_a"), None);
        assert!(client.introspect("second", None).await.unwrap().is_some());
        assert_eq!(provider.count(INTROSPECT), 4);

        // A rate-limited provider says nothing, and what was known still stands.
        provider.advance(60_000);
        provider.answer_with(&["k1"], |_| Some((429, String::new())));
        assert!(client.introspect("second", None).await.unwrap().is_none());
        provider.go_down();
        assert!(client.introspect("second", None).await.unwrap().is_some());

        // Told the key is inactive, the answer is dropped: nothing to serve when the provider is out.
        provider.answer_with(&["k1"], |_| introspection(false, "usr_a", "key_a"));
        assert!(client.introspect("second", None).await.unwrap().is_none());
        provider.go_down();
        assert_eq!(client.introspect("second", None).await.err(), Some(unavailable("auth answered 503")));
    }

    #[tokio::test]
    async fn introspection_has_its_preconditions() {
        let provider = Provider::start().await;
        let client = provider.client();
        assert_eq!(client.introspect("secret", Some("not-an-ip")).await.err(), Some(other("ip must be an IP address")));
        let public = AuthClient::new(AuthClientOptions { client_secret: None, ..options(&provider.issuer) }).unwrap();
        assert_eq!(public.introspect("secret", None).await.err(), Some(other("introspection needs a confidential client")));
        assert_eq!(provider.count(INTROSPECT), 0);
    }
}
