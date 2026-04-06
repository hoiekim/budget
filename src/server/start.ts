import path from "path";
import { randomUUID } from "crypto";
import type { ServerRequest, ServerResponse, ApiResponse } from "server";
import {
  initializePostgres,
  PostgresSessionStore,
  scheduledSync,
  stopScheduledSync,
  logger,
  sendAlarm,
  checkLoginRateLimit,
  startRateLimitCleanup,
  stopRateLimitCleanup,
  pool,
  getClientIp,
} from "server";
import type { MaskedUser } from "server/lib/postgres/models/user";
import type { SessionData } from "server/lib/postgres/models/session";
import * as routes from "server/routes";

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const sessionStore = new PostgresSessionStore();

const COOKIE_NAME = "session_id";
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 7; // 7 days in seconds
const COOKIE_MAX_AGE_MS = COOKIE_MAX_AGE_S * 1000;

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

function buildSetCookieHeader(sid: string, maxAge: number, secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(sid)}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

interface Session {
  id: string;
  user?: MaskedUser;
  _destroyed: boolean;
}

function makeSession(id: string, user: MaskedUser | undefined): Session & ServerRequest["session"] {
  const session: Session & ServerRequest["session"] = {
    id,
    user,
    _destroyed: false,
    regenerate(callback: (err?: Error) => void) {
      const oldId = session.id;
      session.id = randomUUID();
      session.user = undefined;
      sessionStore.destroy(oldId).catch(() => undefined);
      callback();
    },
    destroy(callback?: (err?: Error) => void) {
      session._destroyed = true;
      sessionStore
        .destroy(session.id)
        .then(() => callback?.())
        .catch((err: Error) => callback?.(err));
    },
  };
  return session;
}

async function loadSession(request: Request): Promise<Session & ServerRequest["session"]> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookies = parseCookies(cookieHeader);
  const sid = cookies[COOKIE_NAME];

  if (sid) {
    const data = await sessionStore.get(sid).catch(() => null);
    if (data) return makeSession(sid, data.user);
  }

  return makeSession(randomUUID(), undefined);
}

async function persistSession(session: Session, secure: boolean): Promise<string | null> {
  if (session._destroyed) {
    // Clear the cookie regardless of whether the session existed
    return buildSetCookieHeader("", 0, secure);
  }
  if (!session.user) return null;

  const sessionData: SessionData = {
    user: session.user,
    cookie: {
      originalMaxAge: COOKIE_MAX_AGE_MS,
      maxAge: COOKIE_MAX_AGE_MS,
      expires: new Date(Date.now() + COOKIE_MAX_AGE_MS),
      httpOnly: true,
      path: "/",
      secure,
      sameSite: "strict",
    },
  };
  await sessionStore.set(session.id, sessionData);
  return buildSetCookieHeader(session.id, COOKIE_MAX_AGE_S, secure);
}

// ---------------------------------------------------------------------------
// Mutable response helper
// ---------------------------------------------------------------------------

class MutableResponse implements ServerResponse {
  statusCode = 200;
  headersSent = false;
  private _contentType: string | null = null;
  private _body: string | null = null;
  private _chunks: string[] = [];
  private _streamed = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(data: unknown): void {
    this._contentType = "application/json";
    this._body = JSON.stringify(data);
    this.headersSent = true;
  }

  write(data: string): boolean {
    this._streamed = true;
    this._chunks.push(data);
    return true;
  }

  end(): void {}

  getContentType(): string | null {
    return this._contentType;
  }

  getBody(): string | null {
    if (this._body !== null) return this._body;
    if (this._streamed) return this._chunks.join("");
    return null;
  }

  isStreamed(): boolean {
    return this._streamed;
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const allRoutes = Object.values(routes);

const clientPath = path.resolve(import.meta.dir, "..", "client");

const PUBLIC_PATH_METHODS: [string, Set<string> | null][] = [
  ["/login", null],
  ["/plaid-hook", new Set(["POST"])],
  ["/health", new Set(["GET"])],
];

const SECURITY_HEADERS: Record<string, string> = {
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

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

await initializePostgres();
startRateLimitCleanup();
scheduledSync();

const isProduction = process.env.NODE_ENV === "production";

const server = Bun.serve({
  port: process.env.PORT || 3005,

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const fullPath = url.pathname;

    // Serve static files for non-API paths
    if (!fullPath.startsWith("/api")) {
      const filePath = path.join(clientPath, fullPath === "/" ? "index.html" : fullPath);
      const file = Bun.file(filePath);
      if (await file.exists()) return new Response(file);
      // SPA fallback
      return new Response(Bun.file(path.join(clientPath, "index.html")));
    }

    // Strip /api prefix to get the route path
    const apiPath = fullPath.slice(4) || "/";

    if (apiPath !== "/health") {
      logger.info("API request", { method: request.method, path: fullPath });
    }

    // Parse request headers as a plain record
    const headers: Record<string, string | string[] | undefined> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const ip = getClientIp(headers, undefined);

    // Parse body for JSON requests
    let body: unknown = undefined;
    let rawBody: string | undefined = undefined;
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      rawBody = await request.text();
      try {
        body = JSON.parse(rawBody);
      } catch {
        // leave body undefined on parse failure
      }
    }

    // Parse query string params
    const query: Record<string, string | string[] | undefined> = {};
    url.searchParams.forEach((value, key) => {
      const existing = query[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else if (existing !== undefined) {
        query[key] = [existing, value];
      } else {
        query[key] = value;
      }
    });

    // Rate-limit POST /login before session loading to fail fast
    if (request.method === "POST" && apiPath === "/login") {
      if (checkLoginRateLimit(ip)) {
        return jsonResponse(
          { status: "failed", message: "Too many login attempts, try again later" },
          429,
        );
      }
    }

    // Load or create session
    const session = await loadSession(request);

    const req: ServerRequest = {
      method: request.method,
      path: apiPath,
      url: request.url,
      headers,
      query,
      body,
      rawBody,
      session,
      ip,
    };

    // Auth check — reject unauthenticated requests except on public paths
    const entry = PUBLIC_PATH_METHODS.find(([p]) => p === apiPath);
    const isPublic = !!entry && (!entry[1] || entry[1].has(request.method));
    if (!isPublic && !session.user) {
      return jsonResponse({ status: "failed", message: "Not authenticated." }, 401);
    }

    // Route dispatch
    const mutableRes = new MutableResponse();
    let result: ApiResponse<unknown> | null = null;
    let routeHandled = false;

    for (const route of allRoutes) {
      if (route.path === apiPath && route.method === request.method) {
        routeHandled = true;
        result = await route.execute(req, mutableRes);
        break;
      }
    }

    if (!routeHandled) {
      return jsonResponse({ status: "error", message: "Not Found" }, 404);
    }

    // Apply JSON result if the handler returned one and didn't stream
    if (result && !mutableRes.isStreamed()) {
      mutableRes.json(result);
    }

    // Persist session and get Set-Cookie header
    const setCookieValue = await persistSession(session, isProduction);

    // Assemble final response headers
    const responseHeaders: Record<string, string> = { ...SECURITY_HEADERS };
    if (isProduction) {
      responseHeaders["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
    }
    if (setCookieValue) responseHeaders["Set-Cookie"] = setCookieValue;
    const ct = mutableRes.getContentType();
    if (ct) responseHeaders["Content-Type"] = ct;

    return new Response(mutableRes.getBody(), {
      status: mutableRes.statusCode,
      headers: responseHeaders,
    });
  },
});

logger.info("Budget app server is up", { port: server.port });

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

const shutdown = async (signal: string) => {
  logger.info(`${signal} received — shutting down gracefully`);
  stopRateLimitCleanup();
  stopScheduledSync();

  server.stop();
  logger.info("HTTP server closed");

  try {
    await pool.end();
  } catch {
    // ignore pool shutdown errors
  }
  logger.info("Database pool closed");

  // Force exit after 10 seconds if connections don't drain
  setTimeout(() => {
    logger.info("Forcing shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();

  process.exit(0);
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
