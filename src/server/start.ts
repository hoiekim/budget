import path from "path";
import { randomUUID } from "crypto";
import type { ServerRequest, ServerResponse, ApiResponse } from "server";
import {
  initializePostgres,
  scheduledSync,
  stopScheduledSync,
  logger,
  preSessionShedMessage,
  deliverCrashAlarm,
  reportCrashAlarm,
  CRASH_EXIT_DEADLINE_MS,
  startRateLimitCleanup,
  stopRateLimitCleanup,
  pool,
  getClientIp,
  SECURITY_HEADERS,
  responseSecurityHeaders,
  serveStatic,
  MAX_REQUEST_BODY_SIZE,
  emitToSharingGroup,
  originTabPayload,
  mutationEmitDomain,
  mutationSideEffectDomains,
  JsonStream,
  sendAlarm,
  isProduction,
} from "server";
import { resolveBearerAuth } from "server/lib/bearer-auth";
import { Unavailable } from "server/lib/auth-client";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_S,
  buildSessionCookie,
  loadSessionData,
  parseCookies,
  saveSession,
  sessionStore,
} from "server/lib/session";
import {
  AUTH_CALLBACK_PATH,
  AUTH_EVENTS_PATH,
  getSso,
  initializeSso,
  ssoPublicPathMethods,
} from "server/lib/sso";
import type { MaskedUser } from "server/lib/postgres/models/user";
import type { SessionAuth } from "server/lib/postgres/models/session";
import * as routes from "server/routes";
import { isApiPath } from "common/utils";

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

interface Session {
  id: string;
  user?: MaskedUser;
  auth?: SessionAuth;
  _destroyed: boolean;
  // True when the session's row was read from the store on this request.
  _stored: boolean;
  // True when the request authenticated via Authorization: Bearer (API key).
  // Bearer auth is stateless — we must not write a session cookie back.
  _bearer?: boolean;
}

function makeSession(
  id: string,
  user: MaskedUser | undefined,
  auth?: SessionAuth,
): Session & ServerRequest["session"] {
  const session: Session & ServerRequest["session"] = {
    id,
    user,
    auth,
    _destroyed: false,
    _stored: user !== undefined,
    async regenerate() {
      const oldId = session.id;
      session.id = randomUUID();
      session.user = undefined;
      session.auth = undefined;
      session._stored = false;
      await sessionStore().destroy(oldId);
    },
    async destroy() {
      session._destroyed = true;
      await sessionStore().destroy(session.id);
    },
  };
  return session;
}

async function loadSession(request: Request): Promise<Session & ServerRequest["session"]> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookies = parseCookies(cookieHeader);
  const sid = cookies[SESSION_COOKIE_NAME];

  if (sid) {
    const data = await loadSessionData(sid).catch(() => null);
    if (data) return makeSession(sid, data.user, data.auth);
  }

  return makeSession(randomUUID(), undefined);
}

async function persistSession(session: Session, secure: boolean): Promise<string | null> {
  if (session._destroyed) {
    // Clear the cookie regardless of whether the session existed
    return buildSessionCookie("", 0, secure);
  }
  // Bearer-authenticated requests are stateless: never bind a session cookie
  // to the holder of an API key.
  if (session._bearer) return null;
  if (!session.user) return null;

  await saveSession(session.id, session.user, secure, session._stored);
  return buildSessionCookie(session.id, SESSION_MAX_AGE_S, secure);
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

/**
 * Answers a request whose handling threw outside any route's own catch, with
 * the same log, alarm and JSON body a failing route produces. The alarm key is
 * fixed because the path is caller-controlled.
 */
function unhandledRequestError(error: unknown, method?: string, path?: string): Response {
  logger.error("Unhandled request error", { method, path }, error);
  const where = method && path ? `**Request:** ${method} ${path}\n` : "";
  sendAlarm(
    "Unhandled Request Error",
    `${where}**Error:** ${error instanceof Error ? error.message : String(error)}`,
  ).catch(() => undefined);
  return jsonResponse({ status: "error", message: "Internal server error" }, 500);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// These are the process's only crash handlers — `postgres/client.ts` must not
// register its own, or its earlier-registered listener reaches process.exit
// first and kills the alarm below mid-flight. Registered before the boot
// sequence so a rejection during it is logged and alarmed rather than killing
// the process bare.
//
// `unhandledRejection` does not exit, so the process outlives its POST and the
// alarm stays fire-and-forget. `uncaughtException` exits, so it has to await
// the delivery under the bounded race first.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {}, reason);
  void reportCrashAlarm("Unhandled Promise Rejection", reason);
});

// A second uncaught exception during the delivery window would reach
// `process.exit` and truncate the first crash's in-flight alarm POST.
let crashing = false;

process.on("uncaughtException", async (error) => {
  logger.error("Uncaught exception", {}, error);
  if (crashing) return;
  crashing = true;
  // The guard makes this block the only path to `process.exit`, and the
  // teardown below can outlast the deadline `deliverCrashAlarm` promises —
  // `pool.end()` waits on checked-out clients that a dead database never
  // returns. Exit on a deadline so a crash always yields an exit code.
  setTimeout(() => process.exit(1), CRASH_EXIT_DEADLINE_MS).unref();
  await deliverCrashAlarm("Uncaught Exception", error);
  try {
    await pool.end();
  } catch {
    // ignore pool shutdown errors during crash
  }
  process.exit(1);
});

// Settings only: nothing here contacts the identity provider, so the app
// starts whether or not it is reachable. A bad setting stops the start.
initializeSso();
const sso = getSso();
if (sso) {
  logger.info("Single sign-on is on", {
    issuer: sso.config.issuer,
    localLogin: sso.config.localLogin,
  });
}

// No logDroppedConnections call: Bun.sql has no attach-after-construction
// hook, so dropped-connection logging is wired into the client's own
// `onclose` at construction (see postgres/client.ts).
await initializePostgres();
startRateLimitCleanup();
scheduledSync();

// ---------------------------------------------------------------------------
// Request logging
//
// One structured access-log line per API request: caller context (user, ip), a
// payload hint (field NAMES only, never values), and the outcome (status,
// durationMs) — enough that each line is debuggable on its own.
// ---------------------------------------------------------------------------

type RequestLogContext = Record<string, unknown>;

// Returns the body's field NAMES only — never values, which can carry
// credentials/tokens (e.g. POST /login's password). Enough of a payload hint
// to tell two same-path calls apart without logging anything sensitive.
function payloadHint(body: unknown): string[] | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const keys = Object.keys(body as Record<string, unknown>);
  return keys.length > 0 ? keys : undefined;
}

// Runs the request and fills `log` with caller/payload context as it resolves.
// Returns the Response for every exit path (rate-limit, auth, not-found, ok) so
// the caller can stamp status + duration onto a single log line afterward.
async function handleApiRequest(
  request: Request,
  url: URL,
  apiPath: string,
  log: RequestLogContext,
  socketIp: string | undefined,
  setIdleTimeout: (seconds: number) => void,
): Promise<Response> {
  // Parse request headers as a plain record
  const headers: Record<string, string | string[] | undefined> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const ip = getClientIp(headers, socketIp);
  log.ip = ip;

  const shedMessage = preSessionShedMessage(request.method, apiPath, ip);
  if (shedMessage) {
    return jsonResponse({ status: "failed", message: shedMessage }, 429);
  }

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
  } else if (apiPath === AUTH_EVENTS_PATH) {
    // A security event token arrives as `application/secevent+jwt`.
    rawBody = await request.text();
  }
  const bodyFields = payloadHint(body);
  if (bodyFields) log.bodyFields = bodyFields;

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
  // The callback's query carries a one-time authorization code.
  if (Object.keys(query).length > 0 && apiPath !== AUTH_CALLBACK_PATH) log.query = query;

  // Load or create session
  const session = await loadSession(request);
  log.user = session.user?.username ?? "anonymous";

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
    signal: request.signal,
    setIdleTimeout,
  };

  // Look up the matching route up-front so we can consult its requiredScope
  // before the auth gate.
  const matchedRoute = allRoutes.find(
    (r) => r.path === apiPath && r.method === request.method,
  );

  // Bearer auth: only attempted when the matched route declares a
  // requiredScope, and only as a fallback when no cookie session is
  // present. Cookie sessions remain authoritative for everything.
  let bearerResult: Awaited<ReturnType<typeof resolveBearerAuth>>;
  try {
    bearerResult = await resolveBearerAuth({
      authorizationHeader: headers["authorization"],
      hasCookieSession: !!session.user,
      requiredScope: matchedRoute?.requiredScope,
      ip,
    });
  } catch (error) {
    if (!(error instanceof Unavailable)) throw error;
    return jsonResponse(
      { status: "failed", message: "Cannot check the API key right now. Try again later." },
      503,
    );
  }
  if (bearerResult) {
    session.user = bearerResult.user;
    (session as Session)._bearer = true;
    log.user = session.user?.username ?? "anonymous";
    log.auth = "bearer";
  }

  // Auth check — reject unauthenticated requests except on public paths
  const entry = [...PUBLIC_PATH_METHODS, ...ssoPublicPathMethods()].find(([p]) => p === apiPath);
  const isPublic = !!entry && (!entry[1] || entry[1].has(request.method));
  if (!isPublic && !session.user) {
    return jsonResponse({ status: "failed", message: "Not authenticated." }, 401);
  }

  // Route dispatch
  const mutableRes = new MutableResponse();
  let result: ApiResponse<unknown> | Response | JsonStream | null = null;
  let routeHandled = false;

  if (matchedRoute) {
    routeHandled = true;
    result = await matchedRoute.execute(req, mutableRes);
  }

  if (!routeHandled) {
    return jsonResponse({ status: "error", message: "Not Found" }, 404);
  }

  // A route may return a raw `Response` when it owns its own body (e.g. an
  // SSE stream that must stay open for the tab's lifetime). Pass it through
  // unmodified — no MutableResponse buffering, no session-cookie rebind. A
  // raw-Response route is not a mutation surface, so skip the emit path too.
  if (result instanceof Response) {
    return result;
  }

  if (result instanceof JsonStream) {
    const body = result.toReadableStream((error) => {
      logger.error("Streamed response failed", { method: request.method, path: apiPath }, error);
      sendAlarm(
        `Route Error: ${request.method} ${apiPath}`,
        `**Error:** ${error instanceof Error ? error.message : String(error)}`,
      ).catch(() => undefined);
    });
    return new Response(body, {
      status: mutableRes.statusCode,
      headers: await finalResponseHeaders(session, "application/json"),
    });
  }

  // Real-time collaboration signal: a successful mutation broadcasts a
  // `<domain>-updated` event to the open tabs of the acting user and of
  // everyone sharing data with them, so they re-sync.
  // `originTabId` (the caller's `X-Tab-Id`) is echoed back so the tab that made
  // the change can filter its own event and skip a redundant self-refetch — its
  // local state was already patched optimistically by `useMutate`.
  const emitDomain = mutationEmitDomain(request.method, apiPath);
  if (emitDomain && result?.status === "success" && session.user) {
    void emitToSharingGroup(session.user.user_id, emitDomain, originTabPayload(headers));
    for (const domain of mutationSideEffectDomains(request.method, apiPath)) {
      void emitToSharingGroup(session.user.user_id, domain, {});
    }
  }

  // Apply JSON result if the handler returned one and didn't stream
  if (result && !mutableRes.isStreamed()) {
    mutableRes.json(result);
  }

  return new Response(mutableRes.getBody(), {
    status: mutableRes.statusCode,
    headers: await finalResponseHeaders(session, mutableRes.getContentType()),
  });
}

/** Persists the session and assembles the headers every route response carries. */
async function finalResponseHeaders(
  session: Session,
  contentType: string | null,
): Promise<Record<string, string>> {
  // Best-effort: the route already produced its response, and a dead
  // database must not replace it with the runtime's fallback error page.
  // If the persist fails, the session simply isn't refreshed this request —
  // the client keeps its existing cookie and the next request persists again.
  let setCookieValue: string | null = null;
  try {
    setCookieValue = await persistSession(session, isProduction());
  } catch (error) {
    logger.error("Session persist failed", {}, error);
  }
  const responseHeaders = responseSecurityHeaders();
  if (setCookieValue) responseHeaders["Set-Cookie"] = setCookieValue;
  if (contentType) responseHeaders["Content-Type"] = contentType;
  return responseHeaders;
}

const server = Bun.serve({
  port: process.env.PORT || 3005,
  maxRequestBodySize: MAX_REQUEST_BODY_SIZE,

  async fetch(request, server): Promise<Response> {
    const url = new URL(request.url);
    const fullPath = url.pathname;

    // Serve static files for non-API paths. `isApiPath` rejects /api-anything
    // (e.g. /api-key-detail SPA route) so those fall through to the SPA.
    if (!isApiPath(fullPath)) return serveStatic(clientPath, fullPath);

    // Strip /api prefix to get the route path
    const apiPath = fullPath.slice(4) || "/";

    const startTime = performance.now();
    const log: RequestLogContext = { method: request.method, path: fullPath };
    let response: Response;
    try {
      response = await handleApiRequest(
        request,
        url,
        apiPath,
        log,
        server.requestIP(request)?.address,
        (seconds) => server.timeout(request, seconds),
      );
    } catch (error) {
      response = unhandledRequestError(error, request.method, fullPath);
    }

    // /health is polled constantly by uptime checks and carries no debugging
    // value — keep it out of the log as before.
    if (apiPath !== "/health") {
      log.status = response.status;
      log.durationMs = Math.round(performance.now() - startTime);
      logger.info("API request", log);
    }

    return response;
  },

  // Without this, Bun answers with its development error page, which carries
  // server paths and source lines whenever NODE_ENV is not "production".
  error(error) {
    return unhandledRequestError(error);
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
