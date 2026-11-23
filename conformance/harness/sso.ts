/**
 * Signing in through the fake identity provider, the way a browser does:
 * `GET /auth/login`, the provider's redirect back, `GET /auth/callback`.
 * Tests of the flow itself drive the two requests through `startSsoLogin`
 * and `finishSsoLogin`; every other test that needs a single sign-on session
 * calls `ssoSignIn`.
 */
import type { ApiClient, ApiResult, RequestOptions } from "./client";
import type { Stack } from "./stack";
import { jsonResponse } from "./upstreams/hub";

/** What the login cookie carries from `/auth/login` to `/auth/callback`. */
export interface LoginCookie {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  iat: number;
  maxAge?: number;
  fresh: boolean;
}

export const LOGIN_COOKIE_NAME = "__Host-login";
/** The `Set-Cookie` value that deletes the login cookie. */
export const CLEAR_LOGIN_COOKIE = `${LOGIN_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

export const encodeLoginCookie = (login: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(login)).toString("base64url");

export const decodeLoginCookie = (value: string): LoginCookie => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

export interface StartedSsoLogin {
  result: ApiResult;
  /** Where the browser is sent: the provider's authorization endpoint. */
  location: URL;
  state: string;
  nonce: string;
  /** The login cookie as the client now holds it, decoded. */
  cookie: LoginCookie;
}

/** `GET /auth/login`; throws unless the answer is the redirect to the provider. */
export const startSsoLogin = async (client: ApiClient, options: RequestOptions = {}): Promise<StartedSsoLogin> => {
  const result = await client.get("/auth/login", options);
  const location = result.headers.get("location");
  const value = client.cookies.get(LOGIN_COOKIE_NAME);
  if (result.status !== 302 || !location || !value || !location.includes("state=")) {
    throw new Error(`/auth/login did not start a sign-in: ${result.status} ${location} ${result.text}`);
  }
  const url = new URL(location);
  return {
    result,
    location: url,
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
    cookie: decodeLoginCookie(value),
  };
};

export interface SsoTokens {
  /** Claims of the access token, over the fake's defaults (`usr_alice`, `alice`, role `user`, session `ses_1`). */
  claims?: Record<string, unknown>;
  /** Claims of the ID token, over the defaults: its `sub` follows the access token's, its `nonce` the sign-in's, and its `email` is `<sub>@example.test`. */
  idClaims?: Record<string, unknown>;
  /** The refresh token the provider hands out; `null` for none. Default `rt-<sub>`. */
  refreshToken?: string | null;
}

/** The token endpoint's answer to the code of the sign-in `started`. */
export const tokenAnswer = (stack: Stack, started: { nonce: string }, tokens: SsoTokens = {}): Record<string, unknown> => {
  const { issuer } = stack.upstream;
  const sub = (tokens.claims?.sub as string | undefined) ?? "usr_alice";
  const answer: Record<string, unknown> = {
    access_token: issuer.accessToken(tokens.claims),
    id_token: issuer.idToken({ sub, email: `${sub}@example.test`, nonce: started.nonce, ...tokens.idClaims }),
    token_type: "Bearer",
  };
  const refreshToken = tokens.refreshToken === undefined ? `rt-${sub}` : tokens.refreshToken;
  if (refreshToken !== null) answer.refresh_token = refreshToken;
  return answer;
};

/** `GET /auth/callback` as the provider's redirect would make it, with the fake answering the code with `tokens`. */
export const finishSsoLogin = async (
  stack: Stack,
  client: ApiClient,
  started: { state: string; nonce: string },
  tokens: SsoTokens = {},
  query: Record<string, string> = {},
): Promise<ApiResult> => {
  const { issuer } = stack.upstream;
  const previous = issuer.state.token;
  issuer.state.token = () => jsonResponse(200, tokenAnswer(stack, started, tokens));
  try {
    return await client.get("/auth/callback", { query: { code: "the-code", state: started.state, ...query } });
  } finally {
    issuer.state.token = previous;
  }
};

/**
 * Signs `client` in through single sign-on and returns the callback's
 * answer. Throws unless a session cookie came back.
 */
export const ssoSignIn = async (stack: Stack, client: ApiClient, tokens: SsoTokens = {}): Promise<ApiResult> => {
  const started = await startSsoLogin(client);
  const result = await finishSsoLogin(stack, client, started, tokens);
  if (result.status !== 302 || !client.cookies.has("session_id")) {
    throw new Error(`single sign-on did not complete: ${result.status} ${result.headers.get("location")} ${result.text}`);
  }
  return result;
};

/** The stored session of `client`, as its row. */
export const sessionRow = async (stack: Stack, client: ApiClient): Promise<Record<string, unknown> | undefined> =>
  stack.db.one("SELECT * FROM sessions WHERE session_id = $1", [client.cookies.get("session_id")]);

/** Makes the session's re-check with the identity provider due `secondsAgo` seconds ago. */
export const makeRecheckDue = async (stack: Stack, client: ApiClient, secondsAgo = 1): Promise<void> => {
  await stack.db.query("UPDATE sessions SET auth_recheck_at = $2 WHERE session_id = $1", [
    client.cookies.get("session_id"),
    new Date(Date.now() - secondsAgo * 1000),
  ]);
};
