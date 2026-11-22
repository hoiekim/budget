//! Verifying that a webhook came from Plaid: `src/server/lib/plaid/webhook.ts`.
//!
//! Plaid signs each webhook with an ES256 JWT in the `Plaid-Verification`
//! header, naming the key (`kid`) it signed with; the key is fetched from
//! Plaid's production API and cached.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::Duration;

use base64::Engine;
use futures::future::{BoxFuture, FutureExt, Shared};
use indexmap::IndexSet;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::util::{error_code_of, get_production_client, plaid_error_of};
use crate::js::{json_parse, to_js_string, truthy, Json, JsDate, Obj};
use crate::server::logger;
use crate::server::rate_limit::{RateLimiter, PLAID_KEY_FETCH_RATE_LIMITER};

const KEY_CACHE_TTL: f64 = 1000.0 * 60.0 * 60.0;
/// How long a key_id Plaid says does not exist is remembered.
pub const UNKNOWN_KEY_CACHE_TTL: f64 = 1000.0 * 60.0 * 5.0;
const KEY_FETCH_BUCKET: &str = "global";
const KNOWN_KEY_LIMIT: usize = 100;
const SATURATION_WARN_INTERVAL: f64 = 60.0 * 1000.0;
/// Plaid recommends rejecting webhooks older than this, in seconds.
const MAX_TOKEN_AGE: f64 = 5.0 * 60.0;

/// What verifying a webhook concluded. `Unverifiable` means the answer
/// couldn't be reached (the key couldn't be fetched just now), which the route
/// answers with a status Plaid retries. Plaid treats a 401 as permanent, so
/// only `Invalid` gets one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WebhookVerification {
    Valid,
    Invalid,
    Unverifiable,
}

impl WebhookVerification {
    pub fn as_str(self) -> &'static str {
        match self {
            WebhookVerification::Valid => "valid",
            WebhookVerification::Invalid => "invalid",
            WebhookVerification::Unverifiable => "unverifiable",
        }
    }
}

/// A key, Plaid's word that no such key exists, or no answer yet.
#[derive(Clone, Debug, PartialEq)]
pub enum KeyLookupResult {
    Key(Json),
    Unknown,
    Unavailable,
}

/// Fetches the JWK of a key_id from Plaid.
pub type FetchKey = Arc<dyn Fn(String) -> BoxFuture<'static, anyhow::Result<Json>> + Send + Sync>;

/// A cached answer: a key, or `None` for a key_id Plaid says does not exist.
#[derive(Clone)]
struct CacheEntry {
    key: Option<Json>,
    fetched_at: f64,
}

impl CacheEntry {
    fn ttl(&self) -> f64 {
        if self.key.is_none() {
            UNKNOWN_KEY_CACHE_TTL
        } else {
            KEY_CACHE_TTL
        }
    }

    fn result(&self) -> KeyLookupResult {
        match &self.key {
            Some(key) => KeyLookupResult::Key(key.clone()),
            None => KeyLookupResult::Unknown,
        }
    }
}

type SharedLookup = Shared<BoxFuture<'static, KeyLookupResult>>;

struct LookupState {
    key_cache: HashMap<String, CacheEntry>,
    inflight: HashMap<String, SharedLookup>,
    /// Key_ids that verified since the process started, oldest first.
    known_key_ids: IndexSet<String>,
    last_saturation_warning: f64,
}

/// A verification-key lookup around a fetcher:
///
/// - A key is cached for an hour.
/// - A key_id Plaid says doesn't exist is cached as unknown for five minutes.
///   Any other fetch error is not cached, so the next webhook asks again.
/// - Concurrent lookups of one key_id share a fetch.
/// - Fetches of key_ids that haven't verified since the process started are
///   capped process-wide by the rate limiter; over the cap the answer is
///   `Unavailable` unless the caller grants priority. A key_id that has
///   verified skips the cap when its cache expires.
pub struct VerificationKeyLookup {
    fetch_key: FetchKey,
    limiter: &'static RateLimiter,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
    state: Mutex<LookupState>,
}

/// Plaid's answer for a key_id it has never issued.
fn is_unknown_key_error(error: &anyhow::Error) -> bool {
    error_code_of(plaid_error_of(error)) == Some("INVALID_WEBHOOK_VERIFICATION_KEY_ID")
}

/// Builds a lookup around `fetch_key`, capped by `PLAID_KEY_FETCH_RATE_LIMITER`.
pub fn create_verification_key_lookup(fetch_key: FetchKey) -> Arc<VerificationKeyLookup> {
    VerificationKeyLookup::new(fetch_key, &PLAID_KEY_FETCH_RATE_LIMITER, Arc::new(JsDate::now_ms))
}

impl VerificationKeyLookup {
    /// A lookup capped by `limiter` and reading the time from `now`.
    pub fn new(fetch_key: FetchKey, limiter: &'static RateLimiter, now: Arc<dyn Fn() -> f64 + Send + Sync>) -> Arc<Self> {
        let lookup = Arc::new(VerificationKeyLookup {
            fetch_key,
            limiter,
            now,
            state: Mutex::new(LookupState {
                key_cache: HashMap::new(),
                inflight: HashMap::new(),
                known_key_ids: IndexSet::new(),
                last_saturation_warning: 0.0,
            }),
        });
        // Periodically evicts stale cache entries, so the cache never grows unbounded.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let weak: Weak<VerificationKeyLookup> = Arc::downgrade(&lookup);
            runtime.spawn(async move {
                let period = Duration::from_millis(UNKNOWN_KEY_CACHE_TTL as u64);
                let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
                loop {
                    ticker.tick().await;
                    let Some(lookup) = weak.upgrade() else { return };
                    let now = (lookup.now)();
                    lookup.state.lock().unwrap().key_cache.retain(|_, entry| now - entry.fetched_at < entry.ttl());
                }
            });
        }
        lookup
    }

    fn remember(state: &mut LookupState, key_id: &str) {
        state.known_key_ids.shift_remove(key_id);
        state.known_key_ids.insert(key_id.to_string());
        if state.known_key_ids.len() > KNOWN_KEY_LIMIT {
            state.known_key_ids.shift_remove_index(0);
        }
    }

    async fn fetch_and_cache(self: Arc<Self>, key_id: String) -> KeyLookupResult {
        let fetched = (self.fetch_key)(key_id.clone()).await;
        let mut state = self.state.lock().unwrap();
        let result = match fetched {
            Ok(key) => {
                state.key_cache.insert(key_id.clone(), CacheEntry { key: Some(key.clone()), fetched_at: (self.now)() });
                Self::remember(&mut state, &key_id);
                KeyLookupResult::Key(key)
            }
            Err(error) if is_unknown_key_error(&error) => {
                state.key_cache.insert(key_id.clone(), CacheEntry { key: None, fetched_at: (self.now)() });
                KeyLookupResult::Unknown
            }
            Err(error) => {
                logger::error("Failed to fetch verification key", Some(&crate::ctx! { "component": "plaid.webhook" }), Some(&error));
                KeyLookupResult::Unavailable
            }
        };
        // Removed once settled, before anyone waiting on it resumes.
        state.inflight.remove(&key_id);
        result
    }

    /// The key for `key_id`. `priority` lets an uncached fetch past the
    /// process-wide cap: the caller grants it only when the webhook names a
    /// real item, and bounds it per item.
    pub async fn lookup(self: &Arc<Self>, key_id: &str, priority: bool) -> KeyLookupResult {
        let fetching = {
            let mut state = self.state.lock().unwrap();
            let now = (self.now)();
            if let Some(cached) = state.key_cache.get(key_id) {
                if now - cached.fetched_at < cached.ttl() {
                    return cached.result();
                }
            }

            if let Some(inflight) = state.inflight.get(key_id) {
                inflight.clone()
            } else {
                if !state.known_key_ids.contains(key_id) && !priority {
                    if self.limiter.is_limited(KEY_FETCH_BUCKET) {
                        // At most one line a minute, so a flood shows up without writing a line per request.
                        if now - state.last_saturation_warning >= SATURATION_WARN_INTERVAL {
                            state.last_saturation_warning = now;
                            logger::warn(
                                "Verification key fetches over the cap; answering unavailable",
                                Some(&crate::ctx! { "component": "plaid.webhook" }),
                                None,
                            );
                        }
                        return KeyLookupResult::Unavailable;
                    }
                    self.limiter.consume(KEY_FETCH_BUCKET, 1);
                }
                let fetching = self.clone().fetch_and_cache(key_id.to_string()).boxed().shared();
                state.inflight.insert(key_id.to_string(), fetching.clone());
                fetching
            }
        };
        fetching.await
    }
}

/// The lookup webhooks use: keys come from production, where webhooks are sent from.
static VERIFICATION_KEY_LOOKUP: LazyLock<Arc<VerificationKeyLookup>> = LazyLock::new(|| {
    create_verification_key_lookup(Arc::new(|key_id: String| {
        async move {
            let client = get_production_client()?;
            let data = client.call("/webhook_verification_key/get", &json!({ "key_id": key_id })).await?;
            Ok(data.get("key").cloned().unwrap_or(Json::Null))
        }
        .boxed()
    }))
});

/// Verifies a Plaid webhook: `body` is the raw request body and `signed_jwt`
/// the `Plaid-Verification` header. `priority` is passed to the key lookup
/// (see [`VerificationKeyLookup::lookup`]).
pub async fn verify_webhook(body: &str, signed_jwt: Option<&str>, priority: bool) -> WebhookVerification {
    verify_webhook_with(body, signed_jwt, priority, |key_id, priority| async move {
        VERIFICATION_KEY_LOOKUP.lookup(&key_id, priority).await
    })
    .await
}

/// [`verify_webhook`] with the keys coming from `lookup_key`.
pub async fn verify_webhook_with<F, Fut>(body: &str, signed_jwt: Option<&str>, priority: bool, lookup_key: F) -> WebhookVerification
where
    F: FnOnce(String, bool) -> Fut,
    Fut: Future<Output = KeyLookupResult>,
{
    let component = crate::ctx! { "component": "plaid.webhook" };
    let Some(signed_jwt) = signed_jwt.filter(|jwt| !jwt.is_empty()) else {
        logger::warn("Missing Plaid-Verification header", Some(&component), None);
        return WebhookVerification::Invalid;
    };

    let failed = |message: String| {
        logger::error("Verification failed", Some(&component), Some(&anyhow::anyhow!(message)));
        WebhookVerification::Invalid
    };

    let header = match decode_protected_header(signed_jwt) {
        Ok(header) => header,
        Err(message) => return failed(message),
    };
    let key_id = match header.get("kid") {
        Some(kid) if truthy(kid) => match kid {
            Json::String(kid) => kid.clone(),
            other => to_js_string(other),
        },
        _ => {
            logger::warn("JWT missing key_id (kid)", Some(&component), None);
            return WebhookVerification::Invalid;
        }
    };

    let public_key = match lookup_key(key_id, priority).await {
        KeyLookupResult::Unavailable => return WebhookVerification::Unverifiable,
        KeyLookupResult::Unknown => return WebhookVerification::Invalid,
        KeyLookupResult::Key(key) => key,
    };

    let key = match import_jwk(&public_key, header.get("alg")) {
        Ok(key) => key,
        Err(message) => return failed(message),
    };
    let payload = match jwt_verify(signed_jwt, &key, JsDate::now_ms()) {
        Ok(payload) => payload,
        Err(message) => return failed(message),
    };

    let request_body_hash = match payload.get("request_body_sha256") {
        Some(hash) if truthy(hash) => hash,
        _ => {
            logger::warn("JWT missing request_body_sha256", Some(&component), None);
            return WebhookVerification::Invalid;
        }
    };

    let computed_hash = hex::encode(Sha256::digest(body.as_bytes()));
    if request_body_hash.as_str() != Some(computed_hash.as_str()) {
        logger::warn("Request body hash mismatch", Some(&component), None);
        return WebhookVerification::Invalid;
    }

    WebhookVerification::Valid
}

/// Base64url as jose decodes it: ASCII white space skipped, padding optional.
fn decode_base64url(text: &str) -> Result<Vec<u8>, String> {
    const ENGINE: base64::engine::GeneralPurpose = base64::engine::GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    let compact: String = text.chars().filter(|c| !matches!(c, ' ' | '\t' | '\n' | '\x0c' | '\r')).collect();
    ENGINE.decode(compact).map_err(|_| "The input to be decoded is not correctly encoded.".to_string())
}

/// A base64url segment holding a JSON object.
fn decode_json_object(segment: &str, message: &str) -> Result<Obj, String> {
    let bytes = decode_base64url(segment).map_err(|_| message.to_string())?;
    let text = String::from_utf8(bytes).map_err(|_| message.to_string())?;
    match json_parse(&text) {
        Some(Json::Object(object)) => Ok(object),
        _ => Err(message.to_string()),
    }
}

/// `jose.decodeProtectedHeader`: the header of a compact JWS (three parts) or JWE (five).
fn decode_protected_header(token: &str) -> Result<Obj, String> {
    const INVALID: &str = "Invalid Token or Protected Header formatting";
    let parts: Vec<&str> = token.split('.').collect();
    let encoded = match parts.len() {
        3 | 5 => parts[0],
        _ => return Err(INVALID.to_string()),
    };
    if encoded.is_empty() {
        return Err(INVALID.to_string());
    }
    decode_json_object(encoded, INVALID)
}

/// `jose.importJWK(jwk, alg)` for the one kind of key Plaid signs with: an EC
/// P-256 public key used with ES256.
fn import_jwk(jwk: &Json, header_alg: Option<&Json>) -> Result<VerifyingKey, String> {
    let Json::Object(jwk) = jwk else { return Err("JWK must be an object".to_string()) };
    let alg = header_alg.filter(|alg| !alg.is_null()).or_else(|| jwk.get("alg").filter(|alg| !alg.is_null()));
    if !alg.is_some_and(truthy) {
        return Err("\"alg\" argument is required when \"jwk.alg\" is not present".to_string());
    }
    if alg.and_then(Json::as_str) != Some("ES256") {
        return Err("Unsupported \"alg\" value for a JSON Web Key".to_string());
    }
    if jwk.get("kty").and_then(Json::as_str) != Some("EC") {
        return Err("Invalid key for this operation, its \"kty\" must be \"EC\"".to_string());
    }
    if jwk.get("d").is_some_and(truthy) {
        return Err("ES256 verification requires a public key".to_string());
    }
    if jwk.get("crv").and_then(Json::as_str) != Some("P-256") {
        return Err("The JWK's \"crv\" does not match ES256".to_string());
    }
    let coordinate = |name: &str| -> Result<Vec<u8>, String> {
        let text = jwk.get(name).and_then(Json::as_str).ok_or_else(|| format!("The JWK is missing \"{name}\""))?;
        let bytes = decode_base64url(text)?;
        if bytes.len() != 32 {
            return Err(format!("The JWK's \"{name}\" is not a P-256 coordinate"));
        }
        Ok(bytes)
    };
    let (x, y) = (coordinate("x")?, coordinate("y")?);
    let mut point = Vec::with_capacity(65);
    point.push(0x04);
    point.extend_from_slice(&x);
    point.extend_from_slice(&y);
    VerifyingKey::from_sec1_bytes(&point).map_err(|_| "The JWK is not a point on P-256".to_string())
}

/// `jose.jwtVerify(jwt, key, { maxTokenAge: "5 min" })`: the claims of a
/// compact ES256 JWT whose signature `key` verifies, issued within the last
/// five minutes and neither expired nor not yet valid. `now_ms` is the time.
fn jwt_verify(jwt: &str, key: &VerifyingKey, now_ms: f64) -> Result<Obj, String> {
    let parts: Vec<&str> = jwt.split('.').collect();
    let [protected, payload, signature] = parts.as_slice() else { return Err("Invalid Compact JWS".to_string()) };
    let header = decode_json_object(protected, "JWS Protected Header is invalid")?;

    // The only extension jose recognizes is `b64`, and a JWT must keep its payload encoded.
    if let Some(crit) = header.get("crit") {
        let names: Option<Vec<&str>> = crit.as_array().and_then(|names| names.iter().map(Json::as_str).collect());
        match names {
            Some(names) if !names.is_empty() && names.iter().all(|name| *name == "b64") => {
                if header.get("b64") != Some(&Json::Bool(true)) {
                    return Err("JWTs MUST NOT use unencoded payload".to_string());
                }
            }
            _ => return Err("\"crit\" (Critical) Header Parameter is not supported".to_string()),
        }
    }
    match header.get("alg") {
        Some(Json::String(alg)) if alg == "ES256" => {}
        Some(Json::String(alg)) if !alg.is_empty() => return Err("Invalid key for this operation".to_string()),
        _ => return Err("JWS \"alg\" (Algorithm) Header Parameter missing or invalid".to_string()),
    }
    if !payload.is_ascii() {
        return Err("The payload is not a valid base64url string".to_string());
    }
    let signature = decode_base64url(signature).map_err(|_| "Failed to base64url decode the signature".to_string())?;
    let signing_input = format!("{protected}.{payload}");
    let verified = Signature::from_slice(&signature).ok().is_some_and(|signature| key.verify(signing_input.as_bytes(), &signature).is_ok());
    if !verified {
        return Err("signature verification failed".to_string());
    }

    let claims = decode_json_object(payload, "JWT Claims Set must be a top-level JSON object")?;
    let now = (now_ms / 1000.0).floor();
    let numeric = |claim: &str| -> Result<Option<f64>, String> {
        match claims.get(claim) {
            None => Ok(None),
            Some(Json::Number(n)) => Ok(n.as_f64()),
            Some(_) => Err(format!("\"{claim}\" claim must be a number")),
        }
    };
    let Some(iat) = numeric("iat")? else { return Err("missing required \"iat\" claim".to_string()) };
    if let Some(nbf) = numeric("nbf")? {
        if nbf > now {
            return Err("\"nbf\" claim timestamp check failed".to_string());
        }
    }
    if let Some(exp) = numeric("exp")? {
        if exp <= now {
            return Err("\"exp\" claim timestamp check failed".to_string());
        }
    }
    let age = now - iat;
    if age > MAX_TOKEN_AGE {
        return Err("\"iat\" claim timestamp check failed (too far in the past)".to_string());
    }
    if age < 0.0 {
        return Err("\"iat\" claim timestamp check failed (it should be in the past)".to_string());
    }
    Ok(claims)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::SigningKey;

    use super::*;
    use crate::server::plaid::util::PlaidError;

    fn base64url(value: &Json) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(crate::js::json_stringify(value))
    }

    /// A JWT naming `kid`, signature irrelevant: these tests stop at or before the key lookup.
    fn jwt_with_kid(kid: &str) -> String {
        format!("{}.{}.signature", base64url(&json!({ "alg": "ES256", "typ": "JWT", "kid": kid })), base64url(&json!({ "iat": 0 })))
    }

    const BODY: &str = r#"{"webhook_type":"TRANSACTIONS"}"#;

    async fn never_called(_: String, _: bool) -> KeyLookupResult {
        panic!("no lookup expected")
    }

    // `webhook.test.ts`, "Plaid Webhook Verification".

    #[tokio::test]
    async fn rejects_a_missing_or_empty_header() {
        assert_eq!(verify_webhook_with(BODY, None, false, never_called).await, WebhookVerification::Invalid);
        assert_eq!(verify_webhook_with(BODY, Some(""), false, never_called).await, WebhookVerification::Invalid);
    }

    #[tokio::test]
    async fn rejects_a_malformed_jwt() {
        assert_eq!(verify_webhook_with(BODY, Some("not.a.valid.jwt"), false, never_called).await, WebhookVerification::Invalid);
    }

    #[tokio::test]
    async fn rejects_a_jwt_without_key_id() {
        let no_kid = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature";
        assert_eq!(verify_webhook_with(BODY, Some(no_kid), false, never_called).await, WebhookVerification::Invalid);
    }

    #[tokio::test]
    async fn a_key_id_plaid_says_does_not_exist_is_invalid() {
        let verdict = verify_webhook_with(BODY, Some(&jwt_with_kid("k")), false, |_, _| async { KeyLookupResult::Unknown }).await;
        assert_eq!(verdict, WebhookVerification::Invalid);
    }

    #[tokio::test]
    async fn passes_priority_through_to_the_key_lookup() {
        let seen = Mutex::new(Vec::new());
        verify_webhook_with(BODY, Some(&jwt_with_kid("k")), true, |key_id, priority| {
            seen.lock().unwrap().push((key_id, priority));
            async { KeyLookupResult::Unknown }
        })
        .await;
        assert_eq!(*seen.lock().unwrap(), vec![("k".to_string(), true)]);
    }

    #[tokio::test]
    async fn a_key_that_cannot_be_fetched_just_now_leaves_the_webhook_unverifiable() {
        let verdict = verify_webhook_with(BODY, Some(&jwt_with_kid("k")), false, |_, _| async { KeyLookupResult::Unavailable }).await;
        assert_eq!(verdict, WebhookVerification::Unverifiable);
    }

    // Signed webhooks, end to end.

    fn signing_key() -> SigningKey {
        SigningKey::from_slice(&[7u8; 32]).unwrap()
    }

    fn jwk_of(key: &SigningKey) -> Json {
        let point = key.verifying_key().to_encoded_point(false);
        let encode = |bytes: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        json!({ "alg": "ES256", "crv": "P-256", "kid": "key-1", "kty": "EC", "use": "sig", "x": encode(point.x().unwrap()), "y": encode(point.y().unwrap()) })
    }

    fn sign(key: &SigningKey, header: &Json, claims: &Json) -> String {
        let input = format!("{}.{}", base64url(header), base64url(claims));
        let signature: Signature = key.sign(input.as_bytes());
        format!("{input}.{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }

    fn now_s() -> f64 {
        (JsDate::now_ms() / 1000.0).floor()
    }

    fn body_hash(body: &str) -> String {
        hex::encode(Sha256::digest(body.as_bytes()))
    }

    async fn verdict_of(jwt: &str, body: &str) -> WebhookVerification {
        let jwk = jwk_of(&signing_key());
        verify_webhook_with(body, Some(jwt), false, |_, _| async move { KeyLookupResult::Key(jwk) }).await
    }

    fn header() -> Json {
        json!({ "alg": "ES256", "kid": "key-1", "typ": "JWT" })
    }

    #[tokio::test]
    async fn a_webhook_signed_by_the_key_with_its_body_hash_is_valid() {
        let jwt = sign(&signing_key(), &header(), &json!({ "iat": now_s(), "request_body_sha256": body_hash(BODY) }));
        assert_eq!(verdict_of(&jwt, BODY).await, WebhookVerification::Valid);
    }

    #[tokio::test]
    async fn a_changed_body_an_old_token_or_another_key_is_invalid() {
        let key = signing_key();
        let claims = json!({ "iat": now_s(), "request_body_sha256": body_hash(BODY) });
        assert_eq!(verdict_of(&sign(&key, &header(), &claims), "{}").await, WebhookVerification::Invalid);

        let old = json!({ "iat": now_s() - 301.0, "request_body_sha256": body_hash(BODY) });
        assert_eq!(verdict_of(&sign(&key, &header(), &old), BODY).await, WebhookVerification::Invalid);
        let at_limit = json!({ "iat": now_s() - 299.0, "request_body_sha256": body_hash(BODY) });
        assert_eq!(verdict_of(&sign(&key, &header(), &at_limit), BODY).await, WebhookVerification::Valid);
        let future = json!({ "iat": now_s() + 60.0, "request_body_sha256": body_hash(BODY) });
        assert_eq!(verdict_of(&sign(&key, &header(), &future), BODY).await, WebhookVerification::Invalid);

        let other = SigningKey::from_slice(&[9u8; 32]).unwrap();
        assert_eq!(verdict_of(&sign(&other, &header(), &claims), BODY).await, WebhookVerification::Invalid);
    }

    #[tokio::test]
    async fn claims_without_a_body_hash_or_an_issue_time_are_invalid() {
        let key = signing_key();
        assert_eq!(verdict_of(&sign(&key, &header(), &json!({ "iat": now_s() })), BODY).await, WebhookVerification::Invalid);
        assert_eq!(
            verdict_of(&sign(&key, &header(), &json!({ "request_body_sha256": body_hash(BODY) })), BODY).await,
            WebhookVerification::Invalid
        );
        let expired = json!({ "iat": now_s(), "exp": now_s(), "request_body_sha256": body_hash(BODY) });
        assert_eq!(verdict_of(&sign(&key, &header(), &expired), BODY).await, WebhookVerification::Invalid);
    }

    #[tokio::test]
    async fn another_algorithm_or_a_critical_extension_is_invalid() {
        let key = signing_key();
        let claims = json!({ "iat": now_s(), "request_body_sha256": body_hash(BODY) });
        let hs256 = json!({ "alg": "HS256", "kid": "key-1" });
        assert_eq!(verdict_of(&sign(&key, &hs256, &claims), BODY).await, WebhookVerification::Invalid);
        let crit = json!({ "alg": "ES256", "kid": "key-1", "crit": ["exp"] });
        assert_eq!(verdict_of(&sign(&key, &crit, &claims), BODY).await, WebhookVerification::Invalid);
    }

    #[test]
    fn verifies_a_jwt_signed_the_way_the_conformance_fake_signs_one() {
        // Made by `FakePlaid.signWebhook` (Node's crypto, IEEE P1363 signature), issued at 1700000000.
        let jwk = json!({
            "alg": "ES256",
            "created_at": 1700000000,
            "crv": "P-256",
            "expired_at": null,
            "kid": "fixture-key",
            "kty": "EC",
            "use": "sig",
            "x": "iYu9xFqzLH-uXij59ohmyxdC031Oj5iYJcZr_nW52sw",
            "y": "GDNC67sYjFOPsHWUrtijDyfLo1o_4UUV4WSpHKOe_eg",
        });
        let jwt = concat!(
            "eyJhbGciOiJFUzI1NiIsImtpZCI6ImZpeHR1cmUta2V5IiwidHlwIjoiSldUIn0.",
            "eyJpYXQiOjE3MDAwMDAwMDAsInJlcXVlc3RfYm9keV9zaGEyNTYiOiIwZjE3NWRjNjg0YmNiODBhNDczYmU5MDNjN2FhNWUyMjg4MTFkYzJkZTBlMTRjM2M0ZGZhOTMxMDU1NjMxODgwIn0.",
            "5t0ILtLXow1_OLHHQVmSuRSA5Rd-J5E9s7dznQsjfCR5NvdPPj1EPQ9uQaXJHxv69s6QsWYvP_-SFwE6XiVtpg",
        );
        let body = r#"{"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE"}"#;
        let header = decode_protected_header(jwt).unwrap();
        assert_eq!(header.get("kid"), Some(&json!("fixture-key")));
        let key = import_jwk(&jwk, header.get("alg")).unwrap();
        let claims = jwt_verify(jwt, &key, 1_700_000_100_000.0).unwrap();
        assert_eq!(claims["request_body_sha256"], json!(body_hash(body)));
        // Six minutes on, it is too old.
        assert!(jwt_verify(jwt, &key, 1_700_000_360_000.0).is_err());
        // Without the header's alg, the key's own is used.
        assert!(import_jwk(&jwk, None).is_ok());
        let mut no_alg = jwk.clone();
        no_alg.as_object_mut().unwrap().remove("alg");
        assert!(import_jwk(&no_alg, None).is_err());
    }

    // `webhook.test.ts`, "createVerificationKeyLookup". Each test caps its
    // fetches with a limiter of its own, so tests running at once never share
    // a counter, and reads the time from a clock it moves by hand.

    fn key() -> Json {
        json!({ "kty": "EC", "crv": "P-256", "x": "x", "y": "y" })
    }

    struct Fixture {
        calls: Arc<Mutex<Vec<String>>>,
        clock: Arc<AtomicU64>,
    }

    impl Fixture {
        fn new() -> Self {
            Fixture { calls: Arc::new(Mutex::new(Vec::new())), clock: Arc::new(AtomicU64::new(1_700_000_000_000)) }
        }

        fn set_time(&self, ms: u64) {
            self.clock.store(ms, Ordering::SeqCst);
        }

        fn time(&self) -> u64 {
            self.clock.load(Ordering::SeqCst)
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }

        /// A lookup whose fetcher answers at once: a key for `good-*`, unknown for anything else.
        fn instant(&self, limiter: &'static RateLimiter) -> Arc<VerificationKeyLookup> {
            let calls = self.calls.clone();
            let clock = self.clock.clone();
            VerificationKeyLookup::new(
                Arc::new(move |key_id: String| {
                    calls.lock().unwrap().push(key_id.clone());
                    async move {
                        if key_id.starts_with("good-") {
                            Ok(key())
                        } else {
                            Err(PlaidError::from_response(400, json!({ "error_code": "INVALID_WEBHOOK_VERIFICATION_KEY_ID" })).into())
                        }
                    }
                    .boxed()
                }),
                limiter,
                Arc::new(move || clock.load(Ordering::SeqCst) as f64),
            )
        }
    }

    fn limiter(bucket: &'static str) -> &'static RateLimiter {
        Box::leak(Box::new(RateLimiter::new(bucket, 10, 60_000.0)))
    }

    #[tokio::test]
    async fn shares_one_fetch_between_lookups_that_overlap() {
        let fixture = Fixture::new();
        let (release, gate) = tokio::sync::oneshot::channel::<()>();
        let gate = gate.shared();
        let calls = fixture.calls.clone();
        let lookup = VerificationKeyLookup::new(
            Arc::new(move |key_id: String| {
                calls.lock().unwrap().push(key_id);
                let gate = gate.clone();
                async move {
                    let _ = gate.await;
                    Ok(key())
                }
                .boxed()
            }),
            limiter("test-share"),
            Arc::new(JsDate::now_ms),
        );
        let lookups = futures::future::join_all([lookup.lookup("k1", false), lookup.lookup("k1", false), lookup.lookup("k1", false)]);
        let _ = release.send(());
        assert_eq!(lookups.await, vec![KeyLookupResult::Key(key()); 3]);
        assert_eq!(fixture.calls(), ["k1"]);
    }

    #[tokio::test]
    async fn keeps_a_key_for_an_hour_then_fetches_it_again() {
        let fixture = Fixture::new();
        let lookup = fixture.instant(limiter("test-hour"));
        let start = fixture.time();
        assert_eq!(lookup.lookup("good-1", false).await, KeyLookupResult::Key(key()));
        fixture.set_time(start + UNKNOWN_KEY_CACHE_TTL as u64 + 1);
        assert_eq!(lookup.lookup("good-1", false).await, KeyLookupResult::Key(key()));
        assert_eq!(fixture.calls(), ["good-1"]);
        fixture.set_time(start + 60 * 60 * 1000 - 1);
        lookup.lookup("good-1", false).await;
        assert_eq!(fixture.calls(), ["good-1"]);
        fixture.set_time(start + 60 * 60 * 1000 + 1);
        lookup.lookup("good-1", false).await;
        assert_eq!(fixture.calls(), ["good-1", "good-1"]);
    }

    #[tokio::test]
    async fn remembers_a_key_id_plaid_says_does_not_exist_for_five_minutes() {
        let fixture = Fixture::new();
        let lookup = fixture.instant(limiter("test-unknown"));
        let start = fixture.time();
        assert_eq!(lookup.lookup("bogus", false).await, KeyLookupResult::Unknown);
        fixture.set_time(start + 5 * 60 * 1000 - 1);
        assert_eq!(lookup.lookup("bogus", false).await, KeyLookupResult::Unknown);
        assert_eq!(fixture.calls(), ["bogus"]);
        fixture.set_time(start + 5 * 60 * 1000 + 1);
        assert_eq!(lookup.lookup("bogus", false).await, KeyLookupResult::Unknown);
        assert_eq!(fixture.calls(), ["bogus", "bogus"]);
    }

    #[tokio::test]
    async fn does_not_remember_any_other_fetch_error() {
        let fixture = Fixture::new();
        let calls = fixture.calls.clone();
        let lookup = VerificationKeyLookup::new(
            Arc::new(move |key_id: String| {
                let attempt = {
                    let mut calls = calls.lock().unwrap();
                    calls.push(key_id);
                    calls.len()
                };
                async move {
                    if attempt == 1 {
                        Err(PlaidError::transport("socket hang up").into())
                    } else {
                        Ok(key())
                    }
                }
                .boxed()
            }),
            limiter("test-other-error"),
            Arc::new(JsDate::now_ms),
        );
        assert_eq!(lookup.lookup("k2", false).await, KeyLookupResult::Unavailable);
        assert_eq!(lookup.lookup("k2", false).await, KeyLookupResult::Key(key()));
        assert_eq!(fixture.calls(), ["k2", "k2"]);
    }

    #[tokio::test]
    async fn caps_fetches_of_new_key_ids_but_a_key_that_verified_is_fetched_past_the_cap() {
        let fixture = Fixture::new();
        let limiter = limiter("test-cap");
        let lookup = fixture.instant(limiter);
        let start = fixture.time();
        assert_eq!(lookup.lookup("good-2", false).await, KeyLookupResult::Key(key()));
        for i in 0..9 {
            lookup.lookup(&format!("bogus-{i}"), false).await;
        }
        assert_eq!(lookup.lookup("bogus-over", false).await, KeyLookupResult::Unavailable);
        assert!(!fixture.calls().contains(&"bogus-over".to_string()));
        // Cached answers come back whatever the cap says.
        assert_eq!(lookup.lookup("good-2", false).await, KeyLookupResult::Key(key()));
        assert_eq!(lookup.lookup("bogus-0", false).await, KeyLookupResult::Unknown);
        assert_eq!(fixture.calls().iter().filter(|id| *id == "good-2" || *id == "bogus-0").count(), 2);

        fixture.set_time(start + 60 * 60 * 1000 + 1);
        limiter.consume(KEY_FETCH_BUCKET, 10);
        assert_eq!(lookup.lookup("good-2", false).await, KeyLookupResult::Key(key()));
        assert_eq!(fixture.calls().iter().filter(|id| *id == "good-2").count(), 2);
    }

    #[tokio::test]
    async fn lets_a_priority_lookup_fetch_past_a_full_cap() {
        let fixture = Fixture::new();
        let limiter = limiter("test-priority");
        let lookup = fixture.instant(limiter);
        limiter.consume(KEY_FETCH_BUCKET, 10);
        assert_eq!(lookup.lookup("good-3", false).await, KeyLookupResult::Unavailable);
        assert_eq!(lookup.lookup("good-3", true).await, KeyLookupResult::Key(key()));
        assert_eq!(fixture.calls(), ["good-3"]);
    }

    #[tokio::test]
    async fn charges_the_cap_once_for_lookups_that_overlap() {
        let fixture = Fixture::new();
        let limiter = limiter("test-charge-once");
        let lookup = fixture.instant(limiter);
        limiter.consume(KEY_FETCH_BUCKET, 9);
        let lookups = futures::future::join_all([lookup.lookup("good-4", false), lookup.lookup("good-4", false), lookup.lookup("good-4", false)]);
        assert_eq!(lookups.await, vec![KeyLookupResult::Key(key()); 3]);
        assert_eq!(fixture.calls(), ["good-4"]);
    }

    #[tokio::test]
    async fn remembers_the_last_100_key_ids_that_verified_dropping_the_oldest() {
        let fixture = Fixture::new();
        let limiter = limiter("test-lru");
        let lookup = fixture.instant(limiter);
        let start = fixture.time();
        for i in 0..=100 {
            limiter.reset(KEY_FETCH_BUCKET);
            lookup.lookup(&format!("good-lru-{i}"), false).await;
        }
        fixture.set_time(start + 60 * 60 * 1000 + 1);
        limiter.reset(KEY_FETCH_BUCKET);
        limiter.consume(KEY_FETCH_BUCKET, 10);
        assert_eq!(lookup.lookup("good-lru-0", false).await, KeyLookupResult::Unavailable);
        assert_eq!(lookup.lookup("good-lru-1", false).await, KeyLookupResult::Key(key()));
        assert_eq!(lookup.lookup("good-lru-100", false).await, KeyLookupResult::Key(key()));
    }
}
