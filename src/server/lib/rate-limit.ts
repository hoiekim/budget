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

/**
 * One record per (bucket, IP). Buckets share this Map — and therefore the
 * single cleanup timer below — but never share counters, so a limiter that
 * fills up only blocks its own callers.
 */
const attempts = new Map<string, RateLimitRecord>();
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Clean up expired rate limit records to prevent memory growth.
 */
const cleanupStaleRecords = () => {
  const now = Date.now();
  for (const [key, record] of attempts) {
    if (now >= record.resetAt) {
      attempts.delete(key);
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

export interface RateLimiter {
  /**
   * Read-only check: true once the IP has consumed `maxAttempts` slots within
   * the active window. Does NOT mutate state, so a caller can check without
   * charging the quota.
   */
  isLimited(ip: string): boolean;
  /**
   * Consume one slot for the given IP. The caller decides which outcomes cost
   * a slot — the login limiter charges only failed auth (see #389: charging
   * successes locked out anyone signing in from 5+ devices in one window),
   * while a volume limiter charges every accepted request.
   */
  consume(ip: string): void;
  /**
   * Clear the IP's slots so earlier attempts don't accumulate against them for
   * the rest of the window.
   */
  reset(ip: string): void;
}

/**
 * Build a limiter over its own (bucket, IP) counters.
 *
 * @param bucket Namespace for this limiter's counters, unique per limiter
 */
export const createRateLimiter = (
  bucket: string,
  { maxAttempts, windowMs }: { maxAttempts: number; windowMs: number },
): RateLimiter => {
  const keyFor = (ip: string) => `${bucket}:${ip}`;

  return {
    isLimited: (ip) => {
      const record = attempts.get(keyFor(ip));
      return !!record && Date.now() < record.resetAt && record.count >= maxAttempts;
    },
    consume: (ip) => {
      const key = keyFor(ip);
      const now = Date.now();
      const record = attempts.get(key);

      if (record && now < record.resetAt) {
        record.count++;
      } else {
        attempts.set(key, { count: 1, resetAt: now + windowMs });
      }
    },
    reset: (ip) => {
      attempts.delete(keyFor(ip));
    },
  };
};

export const loginRateLimiter = createRateLimiter("login", {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
});
