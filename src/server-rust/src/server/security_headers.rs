//! Baseline security headers stamped on every API response;
//! `src/server/lib/security-headers.ts`.

use crate::server::node_env::is_production;

pub const SECURITY_HEADERS: [(&str, &str); 5] = [
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("X-XSS-Protection", "1; mode=block"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
    (
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' https://cdn.plaid.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://*.plaid.com; frame-src https://cdn.plaid.com; font-src 'self' data:; object-src 'none'; base-uri 'self'",
    ),
];

/// `SECURITY_HEADERS`, plus HSTS under the production posture.
pub fn response_security_headers() -> Vec<(&'static str, &'static str)> {
    let mut headers = SECURITY_HEADERS.to_vec();
    if is_production() {
        headers.push(("Strict-Transport-Security", "max-age=31536000; includeSubDomains"));
    }
    headers
}
