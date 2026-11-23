//! SimpleFin setup tokens and access URLs: `src/server/lib/simple-fin/tokens.ts`.
//! <https://www.simplefin.org/protocol.html>
//!
//! A setup token is a base64-encoded claim URL; claiming it answers the access
//! URL (`https://user:secret@bridge.example.com/simplefin`), which carries the
//! Basic credentials for every later request.

use std::sync::LazyLock;

use base64::Engine;
use regex::Regex;
use url::Url;

use crate::js::decode_uri_component;

/// Private and reserved ranges a SimpleFin URL may not point at, to prevent
/// SSRF: loopback, link-local, private networks and cloud metadata endpoints.
static PRIVATE_IP_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"^127\.",                                 // Loopback (127.0.0.0/8)
        r"^0\.",                                   // This network (0.0.0.0/8)
        r"^10\.",                                  // Private network (10.0.0.0/8)
        r"^172\.(1[6-9]|2\d|3[01])\.",             // Private network (172.16.0.0/12)
        r"^192\.168\.",                            // Private network (192.168.0.0/16)
        r"^169\.254\.",                            // Link-local / AWS metadata (169.254.0.0/16)
        r"^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.", // Shared address space (100.64.0.0/10)
        r"^::1?$",                                 // IPv6 loopback and unspecified
        r"^f[cd][0-9a-f]{2}:",                     // IPv6 unique local (fc00::/7)
        r"^fe[89ab][0-9a-f]:",                     // IPv6 link-local (fe80::/10)
    ]
    .iter()
    .map(|pattern| Regex::new(pattern).unwrap())
    .collect()
});

static IPV4_MAPPED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$").unwrap());

const BLOCKED_HOSTNAMES: [&str; 2] = [
    "localhost",
    "metadata.google.internal", // GCP metadata
];

/// The host as the patterns read it: an IPv6 literal without its brackets, a
/// name without the trailing dot DNS treats as the same name, and an
/// IPv4-mapped IPv6 address (`::ffff:a9fe:a9fe`, as a parsed URL writes it) as
/// the dotted IPv4 address it maps.
fn normalize_host(hostname: &str) -> String {
    let lower = hostname.to_lowercase();
    let unbracketed = lower.strip_prefix('[').unwrap_or(&lower);
    let unbracketed = unbracketed.strip_suffix(']').unwrap_or(unbracketed);
    let host = unbracketed.trim_end_matches('.').to_string();
    let Some(mapped) = IPV4_MAPPED.captures(&host) else { return host };
    let part = |i: usize| u32::from_str_radix(&mapped[i], 16).unwrap_or(0);
    let (high, low) = (part(1), part(2));
    format!("{}.{}.{}.{}", high >> 8, high & 255, low >> 8, low & 255)
}

/// Checks that a SimpleFin URL (the setup URL a token decodes to, or the access
/// URL the claim returns) is safe to fetch: HTTPS, and not a private or
/// internal destination. `label` names the URL in the error: "setup token" or
/// "access URL".
pub fn validate_simple_fin_url(raw_url: &str, label: &str) -> anyhow::Result<Url> {
    let Ok(parsed) = Url::parse(raw_url) else {
        anyhow::bail!("Invalid SimpleFin {label}: URL is malformed");
    };

    if parsed.scheme() != "https" {
        anyhow::bail!("Invalid SimpleFin {label}: URL must use HTTPS (got {}:)", parsed.scheme());
    }

    let hostname = normalize_host(parsed.host_str().unwrap_or(""));

    if BLOCKED_HOSTNAMES.contains(&hostname.as_str()) {
        anyhow::bail!("Invalid SimpleFin {label}: hostname '{hostname}' is not allowed");
    }

    // Bare IP addresses in private ranges.
    if PRIVATE_IP_PATTERNS.iter().any(|pattern| pattern.is_match(&hostname)) {
        anyhow::bail!("Invalid SimpleFin {label}: IP address '{hostname}' is in a private/reserved range");
    }

    Ok(parsed)
}

/// `Buffer.from(text, "base64").toString()`: both alphabets, anything else
/// skipped, decoding stopping at the first `=`, the bytes read as UTF-8.
pub fn decode_base64_leniently(text: &str) -> String {
    let mut bytes = Vec::new();
    let (mut buffer, mut bits) = (0u32, 0u32);
    for c in text.chars() {
        let value = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' | '-' => 62,
            '/' | '_' => 63,
            '=' => break,
            _ => continue,
        };
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The HTTP client for SimpleFin: like the shared one, but it never follows a
/// redirect, whose target would skip the allowlist (and receive the
/// credentials).
pub(super) fn http_client() -> &'static reqwest::Client {
    static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("the HTTP client has valid settings")
    });
    &CLIENT
}

/// What `fetch(url, { redirect: "error" })` throws for a redirect.
pub(super) fn refuse_redirect(response: &reqwest::Response, url: &str) -> anyhow::Result<()> {
    if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
        anyhow::bail!("UnexpectedRedirect fetching \"{url}\". For more information, pass `verbose: true` in the second argument to fetch()");
    }
    Ok(())
}

/// `response.statusText`.
pub(super) fn status_text(response: &reqwest::Response) -> &'static str {
    response.status().canonical_reason().unwrap_or("")
}

/// Claims the access URL a setup token points to. A redirect is refused rather
/// than followed, since its target would skip the allowlist; a non-2xx
/// response fails rather than returning its body, since the caller stores what
/// this returns as the item's access token. The claimed access URL is checked
/// against the allowlist before it is returned.
pub async fn exchange_setup_token(setup_token: &str) -> anyhow::Result<String> {
    let raw_url = decode_base64_leniently(setup_token);
    let setup_url = validate_simple_fin_url(&raw_url, "setup token")?;
    let response = http_client().post(setup_url.as_str()).header("Content-Length", "0").send().await?;
    refuse_redirect(&response, setup_url.as_str())?;
    if !response.status().is_success() {
        anyhow::bail!("SimpleFin token exchange failed: {} {}", response.status().as_u16(), status_text(&response));
    }
    let body = response.text().await?;
    validate_simple_fin_url(&body, "access URL")?;
    Ok(body)
}

/// Where to fetch SimpleFin data and the Basic credentials to fetch it with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimpleFinCredentials {
    pub url: String,
    /// `base64("user:password")`.
    pub credentials: String,
}

/// Splits an access URL into the URL to fetch and its credentials. Both halves
/// come from the parsed URL the allowlist approved, never from splitting the
/// raw string: an extra "@" would otherwise check one host and fetch another.
pub fn decode_access_url(access_url: &str) -> anyhow::Result<SimpleFinCredentials> {
    let parsed = validate_simple_fin_url(access_url, "access URL")?;
    let decode = |text: &str| decode_uri_component(text).ok_or_else(|| anyhow::anyhow!("URI error"));
    let username = decode(parsed.username())?;
    let password = decode(parsed.password().unwrap_or(""))?;
    let credentials = base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
    let path = parsed.path();
    let url = format!("{}{}", parsed.origin().ascii_serialization(), path.strip_suffix('/').unwrap_or(path));
    Ok(SimpleFinCredentials { url, credentials })
}

#[cfg(test)]
mod tests {
    use super::*;

    // `tokens.test.ts`.

    const ACCESS_URL: &str = "https://user:secret@bridge.example.com/simplefin";

    fn verdict(url: &str) -> &'static str {
        match validate_simple_fin_url(url, "setup token") {
            Ok(_) => "allowed",
            Err(_) => "refused",
        }
    }

    #[test]
    fn refuses_private_and_internal_hosts_including_ipv6_literals_and_a_trailing_dot() {
        let refused = [
            "https://localhost/x",
            "https://LOCALHOST/x",
            "https://localhost./x",
            "https://metadata.google.internal./x",
            "https://127.0.0.1/x",
            "https://0x7f000001/x",
            "https://169.254.169.254/x",
            "https://[::1]/x",
            "https://[::]/x",
            "https://[fc00::1]/x",
            "https://[fdab::1]/x",
            "https://[fc12::1]/x",
            "https://[fe80::1]/x",
            "https://[febf::1]/x",
            "https://[::ffff:169.254.169.254]/x",
            "https://[::ffff:127.0.0.1]/x",
            "https://[::ffff:192.168.1.1]/x",
            "http://bridge.example.com/x",
        ];
        let allowed: Vec<&str> = refused.iter().copied().filter(|url| verdict(url) != "refused").collect();
        assert!(allowed.is_empty(), "{allowed:?}");
    }

    #[test]
    fn allows_public_hosts_including_ones_whose_names_look_like_private_prefixes() {
        let allowed = [
            "https://bridge.example.com/x",
            "https://fdab.example.com/x",
            "https://[2001:db8::1]/x",
            "https://[fec0::1]/x",
            "https://[::ffff:203.0.113.10]/x",
            "https://203.0.113.10/x",
        ];
        let refused: Vec<&str> = allowed.iter().copied().filter(|url| verdict(url) != "allowed").collect();
        assert!(refused.is_empty(), "{refused:?}");
    }

    #[test]
    fn names_what_is_wrong_with_the_url() {
        let message = |url: &str, label: &str| validate_simple_fin_url(url, label).unwrap_err().to_string();
        assert_eq!(message("not a url", "setup token"), "Invalid SimpleFin setup token: URL is malformed");
        assert_eq!(message("http://bridge.example.com/x", "access URL"), "Invalid SimpleFin access URL: URL must use HTTPS (got http:)");
        assert_eq!(message("https://LocalHost./x", "setup token"), "Invalid SimpleFin setup token: hostname 'localhost' is not allowed");
        assert_eq!(
            message("https://[::ffff:169.254.169.254]/x", "access URL"),
            "Invalid SimpleFin access URL: IP address '169.254.169.254' is in a private/reserved range"
        );
        assert_eq!(message("https://[::1]/x", "access URL"), "Invalid SimpleFin access URL: IP address '::1' is in a private/reserved range");
    }

    #[tokio::test]
    async fn a_setup_url_outside_the_allowlist_is_never_fetched() {
        let token_for = |url: &str| base64::engine::general_purpose::STANDARD.encode(url);
        for url in ["http://bridge.example.com/claim/abc", "https://169.254.169.254/claim", "https://localhost/claim"] {
            let error = exchange_setup_token(&token_for(url)).await.unwrap_err().to_string();
            assert!(error.starts_with("Invalid SimpleFin setup token"), "{error}");
        }
    }

    #[test]
    fn decodes_a_setup_token_as_node_does() {
        assert_eq!(decode_base64_leniently("aHR0cHM6Ly9icmlkZ2UuZXhhbXBsZS5jb20vY2xhaW0vYWJj"), "https://bridge.example.com/claim/abc");
        // White space and stray characters are skipped, and decoding stops at padding.
        assert_eq!(decode_base64_leniently("aHR0cHM6Ly9 icmlkZ2UuZXhhbXBsZS5jb20vY2xhaW0vYWJj!!"), "https://bridge.example.com/claim/abc");
        assert_eq!(decode_base64_leniently("aHR0cHM6Ly9icm!lkZ2U"), "https://bridge");
        assert_eq!(decode_base64_leniently("YQ==YQ=="), "a");
        assert_eq!(decode_base64_leniently("YQ"), "a");
        assert_eq!(decode_base64_leniently("aHR0-_").as_bytes()[..3], *b"htt");
        assert_eq!(decode_base64_leniently("/w=="), "\u{fffd}");
    }

    #[test]
    fn splits_the_credentials_from_the_url() {
        assert_eq!(
            decode_access_url(ACCESS_URL).unwrap(),
            SimpleFinCredentials {
                url: "https://bridge.example.com/simplefin".to_string(),
                credentials: base64::engine::general_purpose::STANDARD.encode("user:secret"),
            }
        );
    }

    #[test]
    fn fetches_the_host_the_allowlist_checked_however_many_at_signs_the_url_has() {
        assert_eq!(
            decode_access_url("https://user:pass@10.0.0.5@bridge.example.com/simplefin").unwrap().url,
            "https://bridge.example.com/simplefin"
        );
        assert_eq!(decode_access_url("https://bridge.example.com/@10.0.0.5").unwrap().url, "https://bridge.example.com/@10.0.0.5");
    }

    #[test]
    fn drops_a_trailing_slash_and_decodes_escaped_credentials() {
        assert_eq!(
            decode_access_url("https://us%40er:p%3Ass@bridge.example.com/simplefin/").unwrap(),
            SimpleFinCredentials {
                url: "https://bridge.example.com/simplefin".to_string(),
                credentials: base64::engine::general_purpose::STANDARD.encode("us@er:p:ss"),
            }
        );
        assert_eq!(decode_access_url("https://user:pw@bridge.example.com:8443/").unwrap().url, "https://bridge.example.com:8443");
    }

    #[test]
    fn refuses_an_access_url_outside_the_allowlist() {
        assert!(decode_access_url("http://user:secret@bridge.example.com/simplefin").unwrap_err().to_string().contains("must use HTTPS"));
        assert!(decode_access_url("https://user:secret@10.0.0.5/simplefin").unwrap_err().to_string().contains("private/reserved range"));
    }
}
