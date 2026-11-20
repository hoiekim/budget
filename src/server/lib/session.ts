import {
  InvalidGrant,
  Unavailable,
  type AuthClient,
  type Refreshed,
} from "server/lib/auth-client";
import { logger } from "server/lib/logger";
import type { MaskedUser } from "server/lib/postgres/models/user";
import type { SessionAuth, SessionData } from "server/lib/postgres/models/session";
import {
  PostgresSessionStore,
  updateSessionAuth,
} from "server/lib/postgres/repositories/session";
import { getSso } from "server/lib/sso";

export const SESSION_COOKIE_NAME = "session_id";
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 7;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_S * 1000;

/** How long a single sign-on session is served before it is re-checked with the identity provider. */
export const SSO_RECHECK_INTERVAL_MS = 10 * 60 * 1000;
/** How long past its re-check a session is still served while the identity provider is unreachable. */
export const SSO_MAX_STALENESS_MS = 60 * 60 * 1000;
/** How often an open event stream re-reads its session. */
export const SESSION_WATCH_INTERVAL_MS = 60 * 1000;

let store: PostgresSessionStore | undefined;

/** Built on first use: constructing the store arms its hourly expiry sweep. */
export const sessionStore = (): PostgresSessionStore => (store ??= new PostgresSessionStore());

export function parseCookies(cookieHeader: string): Record<string, string> {
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

export function buildSessionCookie(sid: string, maxAge: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sid)}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** A session's row as of now: a fresh expiry, and `auth` only when the caller is starting the session. */
export function buildSessionData(user: MaskedUser, secure: boolean, auth?: SessionAuth): SessionData {
  const data: SessionData = {
    user,
    cookie: {
      originalMaxAge: SESSION_MAX_AGE_MS,
      maxAge: SESSION_MAX_AGE_MS,
      expires: new Date(Date.now() + SESSION_MAX_AGE_MS),
      httpOnly: true,
      path: "/",
      secure,
      sameSite: "strict",
    },
  };
  if (auth) data.auth = auth;
  return data;
}

/**
 * Writes a signed-in session's row with a fresh expiry. `stored` says the row
 * was read on this request. With single sign-on on, an event can delete that
 * row while the request runs, and an UPDATE leaves it deleted where an upsert
 * would bring it back without its single sign-on fields, never to be
 * re-checked again.
 */
export async function saveSession(
  sid: string,
  user: MaskedUser,
  secure: boolean,
  stored: boolean,
): Promise<void> {
  const data = buildSessionData(user, secure);
  if (stored && getSso()) await sessionStore().touch(sid, data);
  else await sessionStore().set(sid, data);
}

async function endSession(sid: string): Promise<null> {
  await sessionStore().destroy(sid);
  return null;
}

async function recheck(
  sid: string,
  data: SessionData,
  auth: SessionAuth,
  client: AuthClient,
): Promise<SessionData | null> {
  if (auth.refreshToken === null) return endSession(sid);
  let refreshed: Refreshed;
  try {
    refreshed = await client.refresh(auth.refreshToken);
  } catch (error) {
    if (error instanceof InvalidGrant) return endSession(sid);
    const context = { component: "sso" };
    if (error instanceof Unavailable) {
      logger.warn("Single sign-on re-check could not reach the identity provider", context, error);
    } else {
      logger.error("Single sign-on re-check failed", context, error);
    }
    if (Date.now() > auth.recheckAt.getTime() + SSO_MAX_STALENESS_MS) return endSession(sid);
    return data;
  }
  // Budget has no roles of its own: any role is access.
  if (!refreshed.claims.role) return endSession(sid);
  const next: SessionAuth = {
    sid: auth.sid,
    refreshToken: refreshed.refreshToken ?? auth.refreshToken,
    recheckAt: new Date(Date.now() + SSO_RECHECK_INTERVAL_MS),
  };
  return (await updateSessionAuth(sid, next)) ? { ...data, auth: next } : null;
}

const rechecks = new Map<string, Promise<SessionData | null>>();

/**
 * The session as it may be served now, or `null` once it has ended, in which
 * case its row is deleted. Only a single sign-on session whose re-check is
 * due costs anything beyond the row already read: one refresh with the
 * identity provider, shared by the session's concurrent requests. A single
 * sign-on session outlives neither single sign-on being turned off nor an
 * hour of the provider being unreachable past its re-check, and a password
 * session doesn't outlive password sign-in being turned off.
 */
export function recheckSession(sid: string, data: SessionData): Promise<SessionData | null> {
  const { auth } = data;
  const sso = getSso();
  // A password session ends while single sign-on is the only way in: its
  // expiry slides forward on every use, so it would otherwise never end.
  if (!auth) return sso && !sso.config.localLogin ? endSession(sid) : Promise.resolve(data);
  if (!sso) return endSession(sid);
  if (auth.recheckAt.getTime() > Date.now()) return Promise.resolve(data);
  let pending = rechecks.get(sid);
  if (!pending) {
    pending = recheck(sid, data, auth, sso.client).finally(() => rechecks.delete(sid));
    rechecks.set(sid, pending);
  }
  return pending;
}

/** The stored session `sid` names, re-checked; `null` when there is none to serve. */
export async function loadSessionData(sid: string): Promise<SessionData | null> {
  const data = await sessionStore().get(sid);
  return data && recheckSession(sid, data);
}

/**
 * Calls `onEnded` once the session `sid` names is gone, read every
 * `intervalMs`. For a connection that outlives the request that opened it,
 * so a session ended on another copy of the app still closes it. A failed
 * read leaves the connection open until a later one succeeds. Returns the
 * function that stops watching.
 */
export function watchSession(
  sid: string,
  onEnded: () => void,
  intervalMs = SESSION_WATCH_INTERVAL_MS,
): () => void {
  let reading = false;
  const timer = setInterval(async () => {
    if (reading) return;
    reading = true;
    try {
      if (!(await loadSessionData(sid))) {
        clearInterval(timer);
        onEnded();
      }
    } catch (error) {
      logger.warn("Session re-read failed; the stream stays open", { component: "sessions" }, error);
    } finally {
      reading = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
