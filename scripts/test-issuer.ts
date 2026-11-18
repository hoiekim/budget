/**
 * A fake OpenID Connect identity provider for single sign-on tests: discovery,
 * a JWKS with an Ed25519 key, and token, introspection and revocation
 * endpoints whose answers a test replaces. The vendored client reaches it
 * through its back-channel URL, so tokens still name the `https` issuer the
 * client checks.
 *
 * Usage:
 *
 *   const issuer = startFakeIssuer();
 *   afterAll(() => issuer.stop());
 *   beforeEach(() => issuer.reset());
 *   configureSso(issuer.config(), { fetch: issuer.fetch });
 */
import { generateKeyPairSync, sign as edSign } from "crypto";
import type { SsoConfig } from "server/lib/sso";

export const TEST_ISSUER = "https://auth.example.test";
export const TEST_CLIENT_ID = "budget";
export const TEST_REDIRECT_URI = "https://budget.example.test/api/auth/callback";

type Handler = (form: URLSearchParams, request: Request) => Response;

export interface SeenRequest {
  path: string;
  form: URLSearchParams;
  headers: Headers;
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "EdDSA", use: "sig" };

const nowS = () => Math.floor(Date.now() / 1000);

const jwt = (header: object, payload: object): string => {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${h}.${p}.${edSign(null, Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
};

export const accessToken = (claims: object = {}): string =>
  jwt(
    { alg: "EdDSA", typ: "at+jwt", kid: "k1" },
    {
      iss: TEST_ISSUER,
      sub: "usr_alice",
      aud: TEST_CLIENT_ID,
      iat: nowS(),
      exp: nowS() + 600,
      sid: "ses_1",
      username: "alice",
      name: "Alice",
      role: "user",
      ...claims,
    },
  );

export const idToken = (claims: object = {}): string =>
  jwt(
    { alg: "EdDSA", typ: "JWT", kid: "k1" },
    {
      iss: TEST_ISSUER,
      sub: "usr_alice",
      aud: TEST_CLIENT_ID,
      iat: nowS(),
      exp: nowS() + 600,
      auth_time: nowS(),
      email: "alice@example.com",
      email_verified: true,
      ...claims,
    },
  );

/** A security event token carrying `events`, e.g. `{ "user.disabled": { sub: "usr_alice" } }`. */
export const eventToken = (events: object, claims: object = {}): string =>
  jwt(
    { alg: "EdDSA", typ: "secevent+jwt", kid: "k1" },
    { iss: TEST_ISSUER, aud: TEST_CLIENT_ID, iat: nowS(), jti: "evt_1", events, ...claims },
  );

const defaults = {
  token: (() => json(200, { access_token: accessToken(), token_type: "Bearer" })) as Handler,
  introspect: (() => json(200, { active: false })) as Handler,
  revoke: (() => new Response(null, { status: 200 })) as Handler,
};

export const startFakeIssuer = () => {
  const state = { ...defaults, seen: [] as SeenRequest[], down: false };

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const form = new URLSearchParams(request.method === "POST" ? await request.text() : "");
      state.seen.push({ path, form, headers: request.headers });
      const at = (p: string) => `${TEST_ISSUER}${p}`;
      switch (path) {
        case "/.well-known/openid-configuration":
          return json(200, {
            issuer: TEST_ISSUER,
            authorization_endpoint: at("/oauth/authorize"),
            token_endpoint: at("/oauth/token"),
            revocation_endpoint: at("/oauth/revoke"),
            introspection_endpoint: at("/oauth/introspect"),
            jwks_uri: at("/.well-known/jwks.json"),
            end_session_endpoint: at("/logout"),
          });
        case "/.well-known/jwks.json":
          return json(200, { keys: [jwk] });
        case "/oauth/token":
          return state.token(form, request);
        case "/oauth/introspect":
          return state.introspect(form, request);
        case "/oauth/revoke":
          return state.revoke(form, request);
      }
      return json(404, { error: "not_found" });
    },
  });

  const backChannelUrl = `http://localhost:${server.port}`;
  // The preload's snapshot rather than the global, which another file may have stubbed.
  const realFetch = (globalThis as unknown as { __REAL_FETCH: typeof fetch }).__REAL_FETCH;

  return {
    state,
    backChannelUrl,
    /**
     * The client's `fetch`: fails like an unreachable host while `state.down`
     * is set. Drops the client's timeout signal, because the preload installs
     * happy-dom's `AbortSignal` process-wide and the runtime's fetch refuses it.
     */
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      if (state.down) throw new TypeError("fetch failed");
      return realFetch(input, { ...init, signal: undefined });
    }) as typeof fetch,
    config: (overrides: Partial<SsoConfig> = {}): SsoConfig => ({
      issuer: TEST_ISSUER,
      clientId: TEST_CLIENT_ID,
      clientSecret: "test-client-secret",
      redirectUri: TEST_REDIRECT_URI,
      backChannelUrl,
      localLogin: false,
      linkUsers: new Map(),
      postLogoutRedirect: "https://budget.example.test/",
      ...overrides,
    }),
    seen: (path: string) => state.seen.filter((request) => request.path === path),
    reset: () => {
      Object.assign(state, defaults, { seen: [], down: false });
    },
    stop: () => server.stop(true),
  };
};

export type FakeIssuer = ReturnType<typeof startFakeIssuer>;
