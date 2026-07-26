/**
 * Baseline security headers stamped on every HTTP response the app emits.
 * Kept in one place so routes that own their own `Response` (e.g. the
 * SSE stream at `/events`) stay consistent with the ones that flow
 * through `handleApiRequest`'s normal buffering path.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' https://cdn.plaid.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self' https://*.plaid.com",
    "frame-src https://cdn.plaid.com",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; "),
};
