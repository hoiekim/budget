import { Request, Response, NextFunction } from "express";

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

// Schedule periodic cleanup
setInterval(cleanupStaleRecords, CLEANUP_INTERVAL_MS);

/**
 * Rate limiter middleware for login endpoint.
 * Allows MAX_ATTEMPTS attempts per WINDOW_MS per IP address.
 */
export const loginLimiter = (req: Request, res: Response, next: NextFunction): void => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
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
