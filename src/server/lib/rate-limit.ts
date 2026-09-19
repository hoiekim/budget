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
 * One record per (bucket, key). Buckets share this Map — and therefore the
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
   * Read-only check: true once the subject has consumed `maxAttempts` slots
   * within the active window. Does NOT mutate state, so a caller can check
   * without charging the quota.
   */
  isLimited(subject: string): boolean;
  /**
   * Slots left in the active window, or the full quota once that window has
   * expired. Read-only, like `isLimited`. A caller whose unit of cost is a
   * downstream call rather than the request reads this first and does only as
   * much work as it can pay for.
   */
  remaining(subject: string): number;
  /**
   * Consume slots for the given subject. The caller decides which outcomes
   * cost a slot: the login limiter charges only failed auth, a volume limiter
   * charges every accepted request. `slots` is how many units of the metered
   * resource this one request is about to spend.
   */
  consume(subject: string, slots?: number): void;
  /**
   * Clear the subject's slots so earlier attempts don't accumulate against
   * them for the rest of the window.
   */
  reset(subject: string): void;
}

/**
 * Build a limiter over its own (bucket, subject) counters. A pre-session
 * limiter has only the client IP to go on; a limiter behind authentication
 * passes the user id, which survives the caller changing address.
 *
 * @param bucket Namespace for this limiter's counters. Must be unique per
 *   limiter and must not contain `:` — the key is `${bucket}:${subject}`, so
 *   a colon in the bucket lets two (bucket, subject) pairs collide onto one
 *   counter once the subject carries colons of its own, as IPv6 addresses do.
 */
export const createRateLimiter = (
  bucket: string,
  { maxAttempts, windowMs }: { maxAttempts: number; windowMs: number },
): RateLimiter => {
  const keyFor = (subject: string) => `${bucket}:${subject}`;

  return {
    isLimited: (subject) => {
      const record = attempts.get(keyFor(subject));
      return !!record && Date.now() < record.resetAt && record.count >= maxAttempts;
    },
    remaining: (subject) => {
      const record = attempts.get(keyFor(subject));
      if (!record || Date.now() >= record.resetAt) return maxAttempts;
      return Math.max(0, maxAttempts - record.count);
    },
    consume: (subject, slots = 1) => {
      const key = keyFor(subject);
      const now = Date.now();
      const record = attempts.get(key);

      if (record && now < record.resetAt) {
        record.count += slots;
      } else {
        attempts.set(key, { count: slots, resetAt: now + windowMs });
      }
    },
    reset: (subject) => {
      attempts.delete(keyFor(subject));
    },
  };
};

export const loginRateLimiter = createRateLimiter("login", {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
});

// Kept under the alarm cooldown's own ceiling: `sendAlarm` lets this bucket
// through once a minute, so a 15-minute window carries at most 15 alarms.
export const clientErrorRateLimiter = createRateLimiter("client-error", {
  maxAttempts: 12,
  windowMs: 15 * 60 * 1000,
});

// Keyed by user id, not IP: the routes are authenticated, and the shared
// resource it protects — the process-wide Polygon rate gate — is consumed
// per lookup regardless of where the lookup came from. One bucket spans
// every route that can reach that gate on caller-supplied input, so the
// ceiling cannot be lifted by moving to a different endpoint.
//
// It counts lookups that get past the local short-circuit, which includes
// the ones the in-process memo then answers for free. That is deliberate:
// the memo is a best-effort cache with a short TTL, so pricing against it
// would make the ceiling depend on what a previous caller happened to warm.
//
// The ceiling sits deliberately above what the gate itself will pass. Each
// novel lookup costs up to two of its slots, so a caller typing symbols by
// hand meets the gate's retryable "busy" answer long before this cap. What
// this stops is the caller who does not read that answer: a script parking a
// new request every few seconds indefinitely.
export const polygonLookupRateLimiter = createRateLimiter("polygon-lookup", {
  maxAttempts: 10,
  windowMs: 60 * 1000,
});

export const POLYGON_LOOKUP_SHED_MESSAGE =
  "Too many ticker lookups, try again in a minute.";

// Keyed by user id, not IP: the route behind it is authenticated. The unit
// charged is the Plaid round trip, not the request — one request can carry many
// unresolved ids.
export const institutionFallbackRateLimiter = createRateLimiter("institution-fallback", {
  maxAttempts: 20,
  windowMs: 60 * 1000,
});

const PRE_SESSION_RATE_LIMITS: {
  method: string;
  path: string;
  limiter: RateLimiter;
  message: string;
}[] = [
  {
    method: "POST",
    path: "/login",
    limiter: loginRateLimiter,
    message: "Too many login attempts, try again later",
  },
  {
    method: "POST",
    path: "/client-error",
    limiter: clientErrorRateLimiter,
    message: "Too many client error reports, try again later",
  },
];

/**
 * The message to shed a request with, or null to let it through.
 *
 * Consulted before the body is read and before the session is loaded, so a
 * caller over its cap costs no parse, no session read and no session write.
 * Read-only: the slot is charged by the route, which decides which outcomes
 * cost one — failed auth for login, every accepted report for client-error.
 */
export const preSessionShedMessage = (
  method: string,
  path: string,
  ip: string,
): string | null => {
  const entry = PRE_SESSION_RATE_LIMITS.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  return entry && entry.limiter.isLimited(ip) ? entry.message : null;
};
