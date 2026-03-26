import { importConfig, setModulePaths, overrideConsoleLog } from "./config";
importConfig();
setModulePaths();
overrideConsoleLog();

import path from "path";
import express, { Router } from "express";
import session from "express-session";
import { initializePostgres, PostgresSessionStore, scheduledSync } from "server";
import { pool } from "server/lib/postgres/client";
import { loginLimiter } from "server/lib/rate-limit";
import * as routes from "server/routes";
import { logger } from "server/lib/logger";

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
        (req as any).rawBody = buf.toString();
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
  logger.info("API request", { method: req.method, path: `/api${req.url}` });
  next();
});

// Apply rate limiting to login endpoint (POST only)
router.post("/login", loginLimiter);

// Auth middleware: require authenticated session for all routes except public ones.
// Public routes:
//   /login  — GET (session check), POST (login), DELETE (logout). All methods needed.
//   /plaid-hook — POST only. Plaid verifies authenticity via HMAC signature; no session needed.
//   /health — GET only. Required by monitoring and load balancers without a session.
// Exact match only — prefix matching would silently expose future sub-routes.
const PUBLIC_PATHS = new Set(["/login", "/plaid-hook", "/health"]);
router.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) {
    return next();
  }
  if (!req.session.user) {
    res.status(401).json({ status: "failed", message: "Not authenticated." });
    return;
  }
  next();
});

Object.values(routes).forEach(({ path, handler }) => router.use(path, handler));

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
  logger.info("Budget app server is up", {
    port: process.env.PORT || 3005,
    env: process.env.NODE_ENV,
  });
  scheduledSync();
});

const shutdown = async (signal: string) => {
  logger.info(`${signal} received — shutting down gracefully`);

  // Stop accepting new connections; wait for in-flight requests to finish
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  logger.info("HTTP server closed");

  // Close the database connection pool
  await pool.end();
  logger.info("Database pool closed");

  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
