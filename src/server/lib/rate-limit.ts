/**
 * Resolve the real client IP from request headers.
 * Prefers X-Real-IP (set by nginx from $remote_addr, cannot be spoofed by the
 * client), then the leftmost X-Forwarded-For entry, then the socket IP fallback.
 */
export const getClientIp = (
  headers: Record<string, string | string[] | undefined>,
  ipFallback?: string,
): string => {
  const xRealIp = headers["x-real-ip"];
  const xForwardedFor = headers["x-forwarded-for"];
  const forwarded = Array.isArray(xForwardedFor)
    ? xForwardedFor[0]
    : xForwardedFor?.split(",")[0]?.trim();
  return (
    (typeof xRealIp === "string" ? xRealIp : undefined) ??
    forwarded ??
    ipFallback ??
    "unknown"
  );
};

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const attempts = new Map<string, RateLimitRecord>();
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Clean up expired rate limit records to prevent memory growth.
 */
const cleanupStaleRecords = () => {
  const now = Date.now();
  for (const [ip, record] of attempts) {
    if (now >= record.resetAt) {
      attempts.delete(ip);
    }
  }
};

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic cleanup interval. Call from start.ts so the timer
 * can be cleared on graceful shutdown (prevents event loop from staying alive).
 */
export const startRateLimitCleanup = () => {
  if (cleanupTimer) return; // already running
  cleanupTimer = setInterval(cleanupStaleRecords, CLEANUP_INTERVAL_MS);
};

/**
 * Stop the periodic cleanup interval. Call from the SIGTERM/SIGINT handler.
 */
export const stopRateLimitCleanup = () => {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
};

/**
 * Read-only check: returns true if the IP has hit the failure cap within
 * the active window. Does NOT mutate state.
 *
 * Successful logins must not consume a slot — that's what failure-only
 * counting prevents. See #389: counting successes locked out anyone who
 * legitimately signed in from 5+ devices within 15 minutes.
 */
export const isLoginRateLimited = (ip: string): boolean => {
  const now = Date.now();
  const record = attempts.get(ip);
  return !!record && now < record.resetAt && record.count >= MAX_ATTEMPTS;
};

/**
 * Record a failed login attempt for the given IP. Call only after auth
 * has actually failed.
 */
export const recordLoginFailure = (ip: string): void => {
  const now = Date.now();
  const record = attempts.get(ip);

  if (record && now < record.resetAt) {
    record.count++;
  } else {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  }
};

/**
 * Clear the bucket for an IP on a successful login so a user's prior
 * failures don't accumulate against them indefinitely within the window.
 */
export const resetLoginAttempts = (ip: string): void => {
  attempts.delete(ip);
};
