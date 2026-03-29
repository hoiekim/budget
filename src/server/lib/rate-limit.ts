import { Request, Response, NextFunction } from "express";

/**
 * Resolve the real client IP from the request.
 * Prefers X-Real-IP (set by nginx from $remote_addr, cannot be spoofed by the
 * client), then the leftmost X-Forwarded-For entry, then Express's req.ip.
 */
export const getClientIp = (req: Request): string => {
  const xRealIp = req.headers["x-real-ip"];
  const xForwardedFor = req.headers["x-forwarded-for"];
  const forwarded = Array.isArray(xForwardedFor)
    ? xForwardedFor[0]
    : xForwardedFor?.split(",")[0]?.trim();
  return (
    (typeof xRealIp === "string" ? xRealIp : undefined) ??
    forwarded ??
    req.ip ??
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
 * Rate limiter middleware for login endpoint.
 * Allows MAX_ATTEMPTS attempts per WINDOW_MS per IP address.
 */
export const loginLimiter = (req: Request, res: Response, next: NextFunction): void => {
  const ip = getClientIp(req);
  const now = Date.now();
  const record = attempts.get(ip);

  if (record && now < record.resetAt) {
    if (record.count >= MAX_ATTEMPTS) {
      res.status(429).json({
        status: "failed",
        message: "Too many login attempts, try again later",
      });
      return;
    }
    record.count++;
  } else {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  }

  next();
};
