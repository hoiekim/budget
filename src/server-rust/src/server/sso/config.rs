//! Single sign-on's settings, read from the environment at boot:
//! `src/server/lib/sso/config.ts`.

use std::fmt;

use indexmap::IndexMap;
use url::Url;

use super::paths::AUTH_CALLBACK_PATH;

#[derive(Clone, Debug)]
pub struct SsoConfig {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub back_channel_url: Option<String>,
    pub audience: Option<String>,
    /// Keep the app's own password sign-in next to single sign-on.
    pub local_login: bool,
    /// Local account to link on first sign-in, keyed by the identity provider's username.
    pub link_users: IndexMap<String, String>,
    /// Where the identity provider sends the browser after signing out.
    pub post_logout_redirect: String,
}

#[derive(Clone, Debug, Default)]
pub struct SsoEnv {
    pub auth_issuer: Option<String>,
    pub auth_client_id: Option<String>,
    pub auth_client_secret: Option<String>,
    pub auth_redirect_uri: Option<String>,
    pub auth_backchannel_url: Option<String>,
    pub auth_audience: Option<String>,
    pub auth_local_login: Option<String>,
    pub auth_link_users: Option<String>,
    pub host_name: Option<String>,
}

pub fn read_sso_env() -> SsoEnv {
    let var = |name: &str| std::env::var(name).ok();
    SsoEnv {
        auth_issuer: var("AUTH_ISSUER"),
        auth_client_id: var("AUTH_CLIENT_ID"),
        auth_client_secret: var("AUTH_CLIENT_SECRET"),
        auth_redirect_uri: var("AUTH_REDIRECT_URI"),
        auth_backchannel_url: var("AUTH_BACKCHANNEL_URL"),
        auth_audience: var("AUTH_AUDIENCE"),
        auth_local_login: var("AUTH_LOCAL_LOGIN"),
        auth_link_users: var("AUTH_LINK_USERS"),
        host_name: var("HOST_NAME"),
    }
}

#[derive(Debug)]
pub struct SsoConfigError {
    pub problems: Vec<String>,
}

impl fmt::Display for SsoConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let list: Vec<String> = self.problems.iter().map(|problem| format!("- {problem}")).collect();
        write!(f, "Single sign-on is misconfigured:\n{}", list.join("\n"))
    }
}

impl std::error::Error for SsoConfigError {}

const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];
const TRUE_VALUES: [&str; 4] = ["true", "1", "yes", "on"];
const FALSE_VALUES: [&str; 4] = ["false", "0", "no", "off"];

fn non_empty(raw: &Option<String>) -> Option<String> {
    raw.as_ref().map(|value| crate::server::validation::js_trim(value).to_string()).filter(|value| !value.is_empty())
}

/// `URL.hostname`: an IPv6 host keeps its brackets.
pub fn hostname_of(url: &Url) -> String {
    match url.host() {
        Some(url::Host::Ipv6(address)) => format!("[{address}]"),
        Some(host) => host.to_string(),
        None => String::new(),
    }
}

/// `URL.host`: the host name, with the port when it is not the scheme's default.
pub fn host_of(url: &Url) -> String {
    match url.port() {
        Some(port) => format!("{}:{}", hostname_of(url), port),
        None => hostname_of(url),
    }
}

/// An https URL, or http on a loopback host, the way the identity provider registers them.
fn is_secure_url(url: &Url) -> bool {
    url.scheme() == "https" || (url.scheme() == "http" && LOOPBACK_HOSTS.contains(&hostname_of(url).as_str()))
}

/// `url.search` is non-empty: a bare `?` does not count.
fn has_search(url: &Url) -> bool {
    url.query().map(|q| !q.is_empty()).unwrap_or(false)
}

fn has_hash(url: &Url) -> bool {
    url.fragment().map(|f| !f.is_empty()).unwrap_or(false)
}

fn check_issuer(raw: &str, problems: &mut Vec<String>) {
    let ok = Url::parse(raw).map(|url| is_secure_url(&url) && !has_search(&url) && !has_hash(&url)).unwrap_or(false);
    if !ok {
        problems.push("AUTH_ISSUER must be an https URL (http only for localhost) with no query or fragment".to_string());
    }
}

fn check_back_channel_url(raw: &Option<String>, problems: &mut Vec<String>) {
    let Some(raw) = raw else { return };
    let ok = Url::parse(raw)
        .map(|url| matches!(url.scheme(), "http" | "https") && !has_search(&url) && !has_hash(&url))
        .unwrap_or(false);
    if !ok {
        problems.push("AUTH_BACKCHANNEL_URL must be an http or https URL with no query or fragment".to_string());
    }
}

fn redirect_uri_of(env: &SsoEnv, problems: &mut Vec<String>) -> Option<String> {
    if let Some(explicit) = non_empty(&env.auth_redirect_uri) {
        let ok = Url::parse(&explicit).map(|url| is_secure_url(&url) && !has_hash(&url)).unwrap_or(false);
        if !ok {
            problems.push("AUTH_REDIRECT_URI must be an https URL (http only for localhost) with no fragment".to_string());
            return None;
        }
        return Some(explicit);
    }
    let Some(host_name) = non_empty(&env.host_name) else {
        problems.push("AUTH_REDIRECT_URI is required when HOST_NAME is not set".to_string());
        return None;
    };
    match Url::parse(&format!("https://{host_name}/api{AUTH_CALLBACK_PATH}")) {
        Ok(derived) if host_of(&derived) == host_name.to_lowercase() => Some(derived.to_string()),
        _ => {
            problems.push(
                "HOST_NAME must be a bare host name to derive AUTH_REDIRECT_URI from it; otherwise set AUTH_REDIRECT_URI"
                    .to_string(),
            );
            None
        }
    }
}

fn parse_local_login(raw: &Option<String>, problems: &mut Vec<String>) -> bool {
    let Some(value) = non_empty(raw).map(|v| v.to_lowercase()) else { return false };
    if FALSE_VALUES.contains(&value.as_str()) {
        return false;
    }
    if TRUE_VALUES.contains(&value.as_str()) {
        return true;
    }
    problems.push("AUTH_LOCAL_LOGIN must be true or false".to_string());
    false
}

fn parse_link_users(raw: &Option<String>, problems: &mut Vec<String>) -> IndexMap<String, String> {
    let trim = crate::server::validation::js_trim;
    let mut links: IndexMap<String, String> = IndexMap::new();
    let mut local_accounts: Vec<String> = Vec::new();
    for entry in raw.as_deref().unwrap_or("").split(',') {
        let trimmed = trim(entry);
        if trimmed.is_empty() {
            continue;
        }
        let parts: Vec<&str> = trimmed.split('=').map(trim).collect();
        let local_account = parts.first().copied().unwrap_or("");
        let auth_username = parts.get(1).copied().unwrap_or("");
        let has_space = parts.concat().chars().any(|c| c.is_whitespace() || c == '\u{feff}');
        if parts.len() != 2 || local_account.is_empty() || auth_username.is_empty() || has_space {
            problems.push(format!("AUTH_LINK_USERS entry \"{trimmed}\" is not of the form <local account>=<auth username>"));
        } else if links.contains_key(auth_username) {
            problems.push(format!("AUTH_LINK_USERS names auth username \"{auth_username}\" more than once"));
        } else if local_accounts.iter().any(|account| account == local_account) {
            problems.push(format!("AUTH_LINK_USERS names local account \"{local_account}\" more than once"));
        } else {
            links.insert(auth_username.to_string(), local_account.to_string());
            local_accounts.push(local_account.to_string());
        }
    }
    links
}

/// `URL.origin` of an http(s) URL.
pub fn origin_of(url: &Url) -> String {
    format!("{}://{}", url.scheme(), host_of(url))
}

/// Single sign-on's settings, or `None` when `AUTH_ISSUER` is unset or empty,
/// which turns the feature off. Fails naming every problem at once.
pub fn parse_sso_config(env: &SsoEnv) -> Result<Option<SsoConfig>, SsoConfigError> {
    let Some(issuer) = non_empty(&env.auth_issuer) else { return Ok(None) };

    let mut problems = Vec::new();
    check_issuer(&issuer, &mut problems);
    let client_id = non_empty(&env.auth_client_id);
    if client_id.is_none() {
        problems.push("AUTH_CLIENT_ID is required when AUTH_ISSUER is set".to_string());
    }
    let client_secret = non_empty(&env.auth_client_secret);
    if client_secret.is_none() {
        problems.push("AUTH_CLIENT_SECRET is required when AUTH_ISSUER is set".to_string());
    }
    let redirect_uri = redirect_uri_of(env, &mut problems);
    let back_channel_url = non_empty(&env.auth_backchannel_url);
    check_back_channel_url(&back_channel_url, &mut problems);
    let local_login = parse_local_login(&env.auth_local_login, &mut problems);
    let link_users = parse_link_users(&env.auth_link_users, &mut problems);

    match (client_id, client_secret, redirect_uri) {
        (Some(client_id), Some(client_secret), Some(redirect_uri)) if problems.is_empty() => {
            let post_logout_redirect = Url::parse(&redirect_uri).map(|url| format!("{}/", origin_of(&url))).unwrap_or_default();
            Ok(Some(SsoConfig {
                issuer,
                client_id,
                client_secret,
                redirect_uri,
                back_channel_url,
                audience: non_empty(&env.auth_audience),
                local_login,
                link_users,
                post_logout_redirect,
            }))
        }
        _ => Err(SsoConfigError { problems }),
    }
}
