import { importConfig, setModulePaths, overrideConsoleLog } from "./config";
importConfig();
setModulePaths();
overrideConsoleLog();

import path from "path";
import express, { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import session from "express-session";
import { initializePostgres, PostgresSessionStore, scheduledSync } from "server";
import { pool } from "server/lib/postgres/client";
import { loginLimiter, startRateLimitCleanup, stopRateLimitCleanup } from "server/lib/rate-limit";
import * as routes from "server/routes";
import { logger } from "server/lib/logger";
import { sendAlarm } from "server/lib/alarm";

const app = express();

// Trust first proxy for secure cookie detection behind reverse proxy
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// Security headers
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// Parse JSON and store raw body for webhook verification
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      // Store raw body for Plaid webhook verification.
      // req.url at this middleware level includes the /api prefix, so we match
      // against "/api/plaid-hook" (not just "/plaid-hook").
      if (req.url === "/api/plaid-hook") {
        (req as express.Request & { rawBody?: string }).rawBody = buf.toString();
      }
    },
  }),
);

app.use(
  session({
    secret: process.env.SECRET || "secret",
    resave: true,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
    store: new PostgresSessionStore(),
  }),
);

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    [
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
  );
  next();
});

const router = Router();

router.use((req, _res, next) => {
  // Suppress healthcheck logs — /api/health is polled every 30s by the
  // Docker healthcheck and would otherwise flood logs with noise.
  if (req.path !== "/health") {
    logger.info("API request", { method: req.method, path: `/api${req.url}` });
  }
  next();
});

// Apply rate limiting to login endpoint (POST only)
router.post("/login", loginLimiter);

// Auth middleware: require authenticated session for all routes except public ones.
// Entries are [path, allowedMethods] — use null to allow all methods.
// Exact path match only — prefix matching would silently expose future sub-routes.
//
//   /login  — GET (session check), POST (login), DELETE (logout).
//   /plaid-hook — POST only. Auth bypass is intentional: Plaid verifies via HMAC signature.
//                 GET/DELETE/etc. hit this path unauthenticated but the route handler only
//                 handles POST, so other methods fall through to 404.
//   /health — GET only. Required by monitoring / load balancers without a session.
const PUBLIC_PATH_METHODS: [string, Set<string> | null][] = [
  ["/login", null],
  ["/plaid-hook", new Set(["POST"])],
  ["/health", new Set(["GET"])],
];
router.use((req, res, next) => {
  const entry = PUBLIC_PATH_METHODS.find(([p]) => p === req.path);
  if (entry) {
    const [, allowedMethods] = entry;
    if (!allowedMethods || allowedMethods.has(req.method)) {
      return next();
    }
  }
  if (!req.session.user) {
    res.status(401).json({ status: "failed", message: "Not authenticated." });
    return;
  }
  next();
});

Object.values(routes).forEach(({ path, handler }) => router.use(path, handler));

// Global 5xx error handler — catches unhandled errors thrown inside route handlers
router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? (err.stack ?? "") : "";
  logger.error("Unhandled route error", { message });
  sendAlarm("Unhandled Route Error", `**Message:** ${message}\n\`\`\`\n${stack.slice(0, 1000)}\n\`\`\``).catch(
    () => undefined,
  );
  if (!res.headersSent) {
    res.status(500).json({ status: "error", message: "Internal server error" });
  }
});

app.use("/api", router);

// Serve the built client. In dev, the client/ dir doesn't exist (Vite serves it
// on its own port), so express.static is a no-op and the wildcard never matches
// real requests — safe to register unconditionally.
// Guarding on NODE_ENV caused a prod outage when the env var was unset (PR #197).
const clientPath = path.resolve(import.meta.dir, "..", "client");
app.use(express.static(clientPath));
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

const httpServer = app.listen(process.env.PORT || 3005, async () => {
  await initializePostgres();
  startRateLimitCleanup();
  logger.info("Budget app server is up", { port: process.env.PORT || 3005 });
  scheduledSync();
});

// Graceful shutdown — stop accepting connections, drain pool, then exit
const shutdown = async (signal: string) => {
  logger.info(`${signal} received — shutting down gracefully`);
  stopRateLimitCleanup();

  // Stop accepting new connections; wait for in-flight requests to finish
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  logger.info("HTTP server closed");
  try {
    await pool.end();
  } catch {
    // ignore pool shutdown errors
  }
  logger.info("Database pool closed");
  process.exit(0);

  // Force exit after 10 seconds if connections don't drain
  setTimeout(() => {
    logger.info("Forcing shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {}, reason);
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? (reason.stack ?? "") : "";
  sendAlarm(
    "Unhandled Promise Rejection",
    `**Message:** ${message}\n\`\`\`\n${stack.slice(0, 1000)}\n\`\`\``,
  ).catch(() => undefined);
});

process.on("uncaughtException", async (error) => {
  logger.error("Uncaught exception", {}, error);
  sendAlarm(
    "Uncaught Exception",
    `**Message:** ${error.message}\n\`\`\`\n${(error.stack ?? "").slice(0, 1000)}\n\`\`\``,
  ).catch(() => undefined);
  try {
    await pool.end();
  } catch {
    // ignore pool shutdown errors during crash
  }
  process.exit(1);
});
