// Vendored from the auth project's `client/auth-client.ts` at commit 609f8c2.
// Update it by copying that file again; do not edit it here.

// The app side of auth (docs/DESIGN.md §7.6), for apps on Bun or Node. One
// file with built-ins only: vendor it at a pinned version. It speaks the
// standard parts (discovery, the code flow with PKCE, JWKS) to any OIDC
// provider, plus the parts no standard library does: introspection of app
// passwords and API keys with its cache, and events.

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { isIP } from "node:net";

export interface AuthClientOptions {
  /** The issuer URL, exactly as tokens carry it in `iss`. */
  issuer: string;
  /** A private-network URL for the same service, used for every server-to-server call. */
  backChannelUrl?: string;
  clientId: string;
  /** Leave out for a public client. */
  clientSecret?: string;
  redirectUri: string;
  /** The `aud` of this app's access tokens and events: its service name. Defaults to `clientId`. */
  audience?: string;
  fetch?: typeof fetch;
  /** Milliseconds since the epoch. For tests. */
  now?: () => number;
}

export interface AccessClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  iat: number;
  exp: number;
  sid: string;
  username: string;
  name: string;
  role: string;
  [claim: string]: unknown;
}

export interface IdClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  iat: number;
  exp: number;
  nonce: string;
  auth_time?: number;
  amr?: string[];
  email?: string | null;
  email_verified?: boolean;
  [claim: string]: unknown;
}

export interface StartLoginOptions {
  /** A local path to land on after sign-in. Anything else is replaced with "/". */
  returnTo?: string;
  maxAge?: number;
  prompt?: "none" | "login";
  loginHint?: string;
}

export interface Login {
  claims: AccessClaims;
  idClaims: IdClaims;
  accessToken: string;
  refreshToken: string | undefined;
  returnTo: string;
  /** A Set-Cookie value that deletes the login cookie. */
  clearCookie: string;
}

export interface Refreshed {
  claims: AccessClaims;
  accessToken: string;
  /** Present when the provider rotated the refresh token (public clients). */
  refreshToken?: string;
}

export interface Introspection {
  sub: string;
  username: string;
  role: string;
  scopes: string[];
  /** The credential's id (`apw_…`, `key_…`), which `credential.revoked` names. */
  id: string | null;
}

/** Known types: session.ended, access.changed, user.disabled, invite.accepted, user.deleted, credential.revoked. Others are returned with `type` and `jti` only, so an app can acknowledge and ignore them. */
export interface AuthEvent {
  type: string;
  jti: string;
  sub?: string;
  sid?: string;
  /** On access.changed: the new role, or null when access was removed. */
  role?: string | null;
  id?: string;
  invite?: string;
}

export interface AuthClient {
  startLogin(req: Request, options?: StartLoginOptions): Promise<{ redirectUrl: string; loginCookie: string }>;
  finishLogin(req: Request): Promise<Login>;
  refresh(refreshToken: string): Promise<Refreshed>;
  verifyAccessToken(jwt: string): Promise<AccessClaims>;
  introspect(secret: string, options?: { ip?: string }): Promise<Introspection | null>;
  forget(which: { sub?: string; id?: string }): void;
  revoke(refreshToken: string): Promise<void>;
  readEvent(body: string): Promise<AuthEvent>;
  logoutUrl(postLogoutRedirect?: string): Promise<string>;
}

/** The provider refused a code or refresh token: end the session. */
export class InvalidGrant extends Error {
  override name = "InvalidGrant";
}

/** auth could not be reached, timed out, or failed on its side. */
export class Unavailable extends Error {
  override name = "Unavailable";
}

/** A token or event failed verification. */
export class InvalidToken extends Error {
  override name = "InvalidToken";
}

export type LoginErrorCode = "no_login_cookie" | "login_expired" | "state_mismatch" | "authorization_error" | "missing_code";

/** The callback can't complete this sign-in; start a new one. */
export class LoginError extends Error {
  override name = "LoginError";
  constructor(
    readonly code: LoginErrorCode,
    /** The provider's `error` parameter, for `authorization_error`. */
    readonly error?: string,
  ) {
    super(error ? `${code}: ${error}` : code);
  }
}

const LEEWAY_S = 30;
const LOGIN_COOKIE = "__Host-login";
const LOGIN_TTL_S = 300;
const TIMEOUT_MS = 5_000;
const JWKS_TTL_MS = 3_600_000;
const JWKS_MIN_INTERVAL_MS = 30_000;
const FRESH_MS = 60_000;
const STALE_MS = 600_000;
const CACHE_MAX = 10_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const B64URL = /^[A-Za-z0-9_-]+$/;
const COOKIE_ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Lax";

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
  introspection_endpoint?: string;
  end_session_endpoint?: string;
}

type Json = Record<string, unknown>;

export function createAuthClient(options: AuthClientOptions): AuthClient {
  const { issuer, clientId, clientSecret, redirectUri } = options;
  checkOptions(options);
  const audience = options.audience ?? clientId;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const issuerBase = issuer.replace(/\/+$/, "");
  const backBase = options.backChannelUrl?.replace(/\/+$/, "");

  function viaBackChannel(endpoint: string): string {
    if (backBase !== undefined && (endpoint === issuerBase || endpoint.startsWith(`${issuerBase}/`))) {
      return backBase + endpoint.slice(issuerBase.length);
    }
    return endpoint;
  }

  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new Unavailable("auth is unreachable");
    }
    if (res.status >= 500) {
      await res.body?.cancel();
      throw new Unavailable(`auth answered ${res.status}`);
    }
    return res;
  }

  async function readJson(res: Response): Promise<Json> {
    try {
      const body: unknown = await res.json();
      if (isObject(body)) return body;
    } catch {}
    throw new Unavailable(`auth answered ${res.status} with a malformed body`);
  }

  let discovery: Promise<Discovery> | undefined;
  function discover(): Promise<Discovery> {
    if (discovery) return discovery;
    const loading = (async () => {
      const res = await call(viaBackChannel(`${issuerBase}/.well-known/openid-configuration`), { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Unavailable(`discovery answered ${res.status}`);
      const doc = await readJson(res);
      // OIDC Discovery §4.3: a document naming another issuer is refused.
      if (doc.issuer !== issuer) throw new Error("the discovery document names a different issuer");
      for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
        if (typeof doc[field] !== "string") throw new Error(`the discovery document has no ${field}`);
      }
      return doc as unknown as Discovery;
    })();
    discovery = loading;
    loading.catch(() => {
      if (discovery === loading) discovery = undefined;
    });
    return loading;
  }

  function authenticate(body: URLSearchParams, headers: Record<string, string>): void {
    if (clientSecret === undefined) {
      body.set("client_id", clientId);
    } else {
      // RFC 6749 §2.3.1: each part is form-encoded before Basic encoding.
      const pair = `${formEncode(clientId)}:${formEncode(clientSecret)}`;
      headers.Authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
    }
  }

  async function post(endpoint: string, params: Record<string, string>, extra: Record<string, string> = {}): Promise<Response> {
    const body = new URLSearchParams(params);
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      ...extra,
    };
    authenticate(body, headers);
    return call(viaBackChannel(endpoint), { method: "POST", headers, body });
  }

  async function tokenRequest(params: Record<string, string>): Promise<Json> {
    const { token_endpoint } = await discover();
    const res = await post(token_endpoint, params);
    const answer = await readJson(res);
    if (res.ok) return answer;
    if (answer.error === "invalid_grant") throw new InvalidGrant("the provider refused the grant");
    if (res.status === 429) throw new Unavailable("the token endpoint is rate limiting this client");
    throw new Error(`the token endpoint refused the request (${errorCode(answer, res)})`);
  }

  let keys = new Map<string, KeyObject>();
  let keysFetchedAt = -Infinity;
  let lastKeysAttempt = -Infinity;
  let keysLoading: Promise<void> | undefined;

  function loadKeys(): Promise<void> {
    if (keysLoading) return keysLoading;
    // Without this floor, tokens with made-up kids could make every request fetch.
    if (now() - lastKeysAttempt < JWKS_MIN_INTERVAL_MS) return Promise.resolve();
    lastKeysAttempt = now();
    keysLoading = (async () => {
      try {
        const { jwks_uri } = await discover();
        const res = await call(viaBackChannel(jwks_uri), { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Unavailable(`the key set answered ${res.status}`);
        const doc = await readJson(res);
        const next = new Map<string, KeyObject>();
        for (const jwk of Array.isArray(doc.keys) ? doc.keys : []) {
          const key = importKey(jwk);
          if (key) next.set(key.kid, key.key);
        }
        keys = next;
        keysFetchedAt = now();
      } finally {
        keysLoading = undefined;
      }
    })();
    return keysLoading;
  }

  async function keyFor(kid: string): Promise<KeyObject> {
    if (now() - keysFetchedAt >= JWKS_TTL_MS || !keys.has(kid)) {
      try {
        await loadKeys();
      } catch (e) {
        // Keep verifying with the keys we have while auth is unreachable.
        if (!(e instanceof Unavailable)) throw e;
      }
      if (keysFetchedAt === -Infinity) throw new Unavailable("auth's signing keys are unavailable");
    }
    const key = keys.get(kid);
    if (!key) throw new InvalidToken("signed with an unknown key");
    return key;
  }

  async function verifyJwt(token: string, typ: string, aud: string, checkExp: boolean): Promise<Json> {
    const parts = typeof token === "string" ? token.split(".") : [];
    if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) throw new InvalidToken("not a JWT");
    const [h, p, s] = parts as [string, string, string];
    const header = parseSegment(h);
    const payload = parseSegment(p);
    // The algorithm is pinned: the header can only confirm it, never choose it.
    if (header.alg !== "EdDSA") throw new InvalidToken("unexpected alg");
    if (typeof header.typ !== "string" || header.typ.toLowerCase() !== typ) throw new InvalidToken("unexpected typ");
    if (header.crit !== undefined) throw new InvalidToken("unsupported critical header");
    if (typeof header.kid !== "string") throw new InvalidToken("no kid");
    const key = await keyFor(header.kid);
    const signature = Buffer.from(s, "base64url");
    if (signature.length !== 64 || !verify(null, Buffer.from(`${h}.${p}`), key, signature)) {
      throw new InvalidToken("bad signature");
    }
    if (payload.iss !== issuer) throw new InvalidToken("wrong issuer");
    const audOk = payload.aud === aud || (Array.isArray(payload.aud) && payload.aud.includes(aud));
    if (!audOk) throw new InvalidToken("wrong audience");
    const t = now() / 1000;
    if (typeof payload.iat !== "number" || payload.iat > t + LEEWAY_S) throw new InvalidToken("issued in the future");
    if (checkExp && (typeof payload.exp !== "number" || t > payload.exp + LEEWAY_S)) throw new InvalidToken("expired");
    return payload;
  }

  async function verifyAccessToken(jwt: string): Promise<AccessClaims> {
    const claims = await verifyJwt(jwt, "at+jwt", audience, true);
    for (const claim of ["sub", "sid", "username", "name", "role"]) {
      if (typeof claims[claim] !== "string") throw new InvalidToken(`no ${claim} claim`);
    }
    return claims as AccessClaims;
  }

  const cache = new Map<string, { answer: Introspection; at: number }>();

  function forget(which: { sub?: string; id?: string }): void {
    if (which.sub === undefined && which.id === undefined) return;
    for (const [key, { answer }] of cache) {
      if ((which.sub !== undefined && answer.sub === which.sub) || (which.id !== undefined && answer.id === which.id)) {
        cache.delete(key);
      }
    }
  }

  async function introspect(secret: string, opts: { ip?: string } = {}): Promise<Introspection | null> {
    if (clientSecret === undefined) throw new Error("introspection needs a confidential client");
    if (opts.ip !== undefined && isIP(opts.ip) === 0) throw new Error("ip must be an IP address");
    // Keyed by digest, so the cache never holds a usable secret.
    const key = createHash("sha256").update(secret).digest("hex");
    const hit = cache.get(key);
    if (hit && now() - hit.at < FRESH_MS) return copy(hit.answer);
    let res: Response;
    let answer: Json | undefined;
    try {
      const { introspection_endpoint } = await discover();
      if (!introspection_endpoint) throw new Error("the provider has no introspection endpoint");
      res = await post(introspection_endpoint, { token: secret }, opts.ip ? { "X-Real-IP": opts.ip } : {});
      if (res.status !== 429) answer = await readJson(res);
    } catch (e) {
      if (e instanceof Unavailable && hit && now() - hit.at < STALE_MS) return copy(hit.answer);
      throw e;
    }
    if (res.status === 429) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok || answer === undefined) throw new Error(`introspection refused the request (${errorCode(answer ?? {}, res)})`);
    if (answer.active !== true) {
      cache.delete(key);
      return null;
    }
    const { sub, username, role, scope, jti } = answer;
    if (typeof sub !== "string" || typeof username !== "string" || typeof role !== "string") {
      throw new Unavailable("introspection answered without sub, username or role");
    }
    const result: Introspection = {
      sub,
      username,
      role,
      scopes: typeof scope === "string" ? scope.split(" ").filter(Boolean) : [],
      id: typeof jti === "string" ? jti : null,
    };
    cache.delete(key);
    cache.set(key, { answer: result, at: now() });
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return copy(result);
  }

  async function readEvent(body: string): Promise<AuthEvent> {
    const set = await verifyJwt(typeof body === "string" ? body.trim() : "", "secevent+jwt", audience, false);
    if (typeof set.jti !== "string" || set.jti === "") throw new InvalidToken("no jti");
    const events = set.events;
    const types = isObject(events) ? Object.keys(events) : [];
    const [type] = types;
    if (types.length !== 1 || type === undefined || !isObject(events)) throw new InvalidToken("a SET carries exactly one event");
    const payload = events[type];
    if (!isObject(payload)) throw new InvalidToken("malformed event payload");
    const event: AuthEvent = { type, jti: set.jti };
    const required = EVENT_FIELDS[type];
    if (required === undefined) return event;
    for (const field of required) {
      const value = payload[field];
      if (typeof value !== "string") throw new InvalidToken(`${type} without ${field}`);
      event[field] = value;
    }
    if (type === "access.changed") {
      if (payload.role !== null && typeof payload.role !== "string") throw new InvalidToken("access.changed without role");
      event.role = payload.role;
    }
    if (type === "credential.revoked") forget({ id: event.id });
    else if (type === "access.changed" || type === "user.disabled" || type === "user.deleted") forget({ sub: event.sub });
    return event;
  }

  return {
    async startLogin(_req, opts = {}) {
      const { authorization_endpoint } = await discover();
      const state = random();
      const nonce = random();
      const verifier = random();
      const url = new URL(authorization_endpoint);
      const params: Record<string, string> = {
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "openid profile email",
        state,
        nonce,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      };
      if (opts.prompt !== undefined) {
        if (opts.prompt !== "none" && opts.prompt !== "login") throw new Error("prompt must be none or login");
        params.prompt = opts.prompt;
      }
      if (opts.maxAge !== undefined) {
        if (!Number.isSafeInteger(opts.maxAge) || opts.maxAge < 0) throw new Error("maxAge must be a whole number of seconds");
        params.max_age = String(opts.maxAge);
      }
      if (opts.loginHint !== undefined) params.login_hint = opts.loginHint;
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
      const returnTo = isLocalPath(opts.returnTo) ? opts.returnTo : "/";
      // What was asked of the sign-in travels with the cookie: the browser
      // carries the request and can drop max_age or prompt from it, so the
      // ID token's auth_time is checked against them at the callback.
      const login = { state, nonce, verifier, returnTo, iat: Math.floor(now() / 1000), maxAge: opts.maxAge, fresh: opts.prompt === "login" };
      const value = Buffer.from(JSON.stringify(login)).toString("base64url");
      return { redirectUrl: url.toString(), loginCookie: `${LOGIN_COOKIE}=${value}; ${COOKIE_ATTRIBUTES}; Max-Age=${LOGIN_TTL_S}` };
    },

    async finishLogin(req) {
      const raw = readCookie(req.headers.get("cookie"), LOGIN_COOKIE);
      const saved = raw !== undefined && B64URL.test(raw) ? parseSegment(raw) : undefined;
      const { state, nonce, verifier, returnTo, iat, maxAge, fresh } = saved ?? {};
      if (typeof state !== "string" || typeof nonce !== "string" || typeof verifier !== "string" || typeof iat !== "number") {
        throw new LoginError("no_login_cookie");
      }
      const t = now() / 1000;
      if (t - iat > LOGIN_TTL_S || iat > t + LEEWAY_S) throw new LoginError("login_expired");
      const query = new URL(req.url).searchParams;
      const error = query.get("error");
      if (error !== null) throw new LoginError("authorization_error", error.slice(0, 64));
      if (!sameDigest(query.get("state") ?? "", state)) throw new LoginError("state_mismatch");
      const code = query.get("code");
      if (!code) throw new LoginError("missing_code");
      const answer = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
      if (typeof answer.access_token !== "string" || typeof answer.id_token !== "string") {
        throw new Unavailable("the token endpoint answered without an access token or ID token");
      }
      const claims = await verifyAccessToken(answer.access_token);
      const idClaims = await verifyJwt(answer.id_token, "jwt", clientId, true);
      if (Array.isArray(idClaims.aud) && idClaims.aud.length > 1 && idClaims.azp !== clientId) throw new InvalidToken("wrong authorized party");
      if (typeof idClaims.nonce !== "string" || !sameDigest(idClaims.nonce, nonce)) throw new InvalidToken("nonce mismatch");
      if (idClaims.sub !== claims.sub) throw new InvalidToken("the ID token names another subject");
      // OIDC Core §3.1.3.7: with max_age or prompt=login, the sign-in must be
      // as recent as asked, whatever the authorization request ended up as.
      if (typeof maxAge === "number" || fresh === true) {
        const authTime = idClaims.auth_time;
        if (typeof authTime !== "number") throw new InvalidToken("no auth_time");
        if (typeof maxAge === "number" && t - authTime > maxAge + LEEWAY_S) throw new InvalidToken("the sign-in is older than max_age");
        if (fresh === true && authTime < iat - LEEWAY_S) throw new InvalidToken("the sign-in is older than the login request");
      }
      return {
        claims,
        idClaims: idClaims as IdClaims,
        accessToken: answer.access_token,
        refreshToken: typeof answer.refresh_token === "string" ? answer.refresh_token : undefined,
        returnTo: isLocalPath(returnTo) ? returnTo : "/",
        clearCookie: `${LOGIN_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`,
      };
    },

    async refresh(refreshToken) {
      const answer = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
      if (typeof answer.access_token !== "string") throw new Unavailable("the token endpoint answered without an access token");
      const claims = await verifyAccessToken(answer.access_token);
      const refreshed: Refreshed = { claims, accessToken: answer.access_token };
      if (typeof answer.refresh_token === "string") refreshed.refreshToken = answer.refresh_token;
      return refreshed;
    },

    verifyAccessToken,
    introspect,
    forget,

    async revoke(refreshToken) {
      const { revocation_endpoint } = await discover();
      if (!revocation_endpoint) throw new Error("the provider has no revocation endpoint");
      const res = await post(revocation_endpoint, { token: refreshToken, token_type_hint: "refresh_token" });
      await res.body?.cancel();
      if (!res.ok) throw new Error(`revocation refused the request (${res.status})`);
    },

    readEvent,

    async logoutUrl(postLogoutRedirect) {
      const { end_session_endpoint } = await discover();
      if (!end_session_endpoint) throw new Error("the provider has no end_session_endpoint");
      const url = new URL(end_session_endpoint);
      url.searchParams.set("client_id", clientId);
      if (postLogoutRedirect !== undefined) url.searchParams.set("post_logout_redirect_uri", postLogoutRedirect);
      return url.toString();
    },
  };
}

const EVENT_FIELDS: Record<string, ("sub" | "sid" | "id" | "invite")[]> = {
  "session.ended": ["sid"],
  "access.changed": ["sub"],
  "user.disabled": ["sub"],
  "invite.accepted": ["invite", "sub"],
  "user.deleted": ["sub"],
  "credential.revoked": ["sub", "id"],
};

function checkOptions(o: AuthClientOptions): void {
  const issuer = parseUrl(o.issuer, "issuer");
  if (!(issuer.protocol === "https:" || (issuer.protocol === "http:" && LOOPBACK.has(issuer.hostname)))) {
    throw new Error("issuer must be an https URL (http only for localhost)");
  }
  if (issuer.search || issuer.hash) throw new Error("issuer must have no query or fragment");
  if (o.backChannelUrl !== undefined) {
    const back = parseUrl(o.backChannelUrl, "backChannelUrl");
    if (back.protocol !== "https:" && back.protocol !== "http:") throw new Error("backChannelUrl must be an http or https URL");
    if (back.search || back.hash) throw new Error("backChannelUrl must have no query or fragment");
  }
  if (typeof o.clientId !== "string" || o.clientId === "") throw new Error("clientId is required");
  parseUrl(o.redirectUri, "redirectUri");
  if (o.clientSecret !== undefined && (typeof o.clientSecret !== "string" || o.clientSecret === "")) {
    throw new Error("clientSecret must be a non-empty string when set");
  }
  if (o.audience !== undefined && (typeof o.audience !== "string" || o.audience === "")) {
    throw new Error("audience must be a non-empty string when set");
  }
}

function parseUrl(value: unknown, name: string): URL {
  if (typeof value !== "string" || value === "") throw new Error(`${name} is required`);
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
}

function importKey(jwk: unknown): { kid: string; key: KeyObject } | undefined {
  if (!isObject(jwk) || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") return;
  if (typeof jwk.x !== "string" || typeof jwk.kid !== "string") return;
  if ((jwk.use !== undefined && jwk.use !== "sig") || (jwk.alg !== undefined && jwk.alg !== "EdDSA")) return;
  try {
    return { kid: jwk.kid, key: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" }) };
  } catch {
    return;
  }
}

function parseSegment(segment: string): Json {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (isObject(value)) return value;
  } catch {}
  throw new InvalidToken("malformed segment");
}

function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

// A path on the app's own origin. URL parsers drop tabs and newlines and read
// a backslash as a slash, so "/\t/evil.example" would lead off-site: any
// control character, space or backslash is refused, and the path must still
// resolve to the same origin.
function isLocalPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > 2048 || !path.startsWith("/") || path.startsWith("//")) return false;
  if (/[\u0000-\u0020\u007f\\]/.test(path)) return false;
  return new URL(path, "https://app.invalid").origin === "https://app.invalid";
}

function sameDigest(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function random(): string {
  return randomBytes(32).toString("base64url");
}

function formEncode(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, "+");
}

function errorCode(answer: Json, res: Response): string {
  return typeof answer.error === "string" && /^[\w.-]{1,64}$/.test(answer.error) ? answer.error : String(res.status);
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copy(answer: Introspection): Introspection {
  return { ...answer, scopes: [...answer.scopes] };
}
