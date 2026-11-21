/**
 * A fake OpenID Connect identity provider, the black-box counterpart of
 * `scripts/test-issuer.ts`: discovery, an Ed25519 key set, and token,
 * introspection and revocation endpoints whose answers a test replaces
 * through `state`. Tokens name the `https` issuer; the servers reach this
 * fake over plain HTTP through `AUTH_BACKCHANNEL_URL`, or, when started
 * without one, at the issuer's own host through the upstream proxy.
 *
 * A test that needs an answer `state` cannot express (another status for
 * discovery or the key set, a slow endpoint) registers its own handler on
 * `stack.upstream.hub` for `ISSUER_HOST`: the newest handler is asked first.
 */
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { jsonResponse, type UpstreamHub, type UpstreamRequest } from "./hub";

export const ISSUER = "https://auth.example.test";
export const ISSUER_HOST = "issuer";
/** The host a server calls when it has no back channel: the issuer's own. */
export const ISSUER_PUBLIC_HOST = new URL(ISSUER).host;
export const CLIENT_ID = "budget";
export const CLIENT_SECRET = "conformance-client-secret";
export const REDIRECT_URI = "https://budget.example.test/api/auth/callback";

type Handler = (form: URLSearchParams, request: UpstreamRequest) => Response | Promise<Response>;

const nowS = () => Math.floor(Date.now() / 1000);

export class FakeIssuer {
  private readonly privateKey: KeyObject;
  private readonly jwk: Record<string, unknown>;
  private server: ReturnType<typeof Bun.serve>;
  private unreachable = false;
  readonly port: number;
  state!: { token: Handler; introspect: Handler; revoke: Handler; down: boolean; discovery: Record<string, unknown> };

  constructor(private readonly hub: UpstreamHub) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    this.privateKey = privateKey;
    this.jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "EdDSA", use: "sig" };
    this.reset();
    hub.on(ISSUER_HOST, (request) => this.handle(request));
    hub.on(ISSUER_PUBLIC_HOST, (request) => this.handle(request));
    this.server = this.listen(0);
    this.port = this.server.port!;
  }

  private listen(port: number): ReturnType<typeof Bun.serve> {
    return Bun.serve({ port, hostname: "127.0.0.1", fetch: (request) => this.hub.answer(request, ISSUER_HOST) });
  }

  get backChannelUrl(): string {
    return `http://localhost:${this.port}`;
  }

  /** The environment that turns single sign-on on against this fake. */
  env(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      AUTH_ISSUER: ISSUER,
      AUTH_CLIENT_ID: CLIENT_ID,
      AUTH_CLIENT_SECRET: CLIENT_SECRET,
      AUTH_REDIRECT_URI: REDIRECT_URI,
      AUTH_BACKCHANNEL_URL: this.backChannelUrl,
      ...overrides,
    };
  }

  private defaultDiscovery(): Record<string, unknown> {
    const at = (p: string) => `${ISSUER}${p}`;
    return {
      issuer: ISSUER,
      authorization_endpoint: at("/oauth/authorize"),
      token_endpoint: at("/oauth/token"),
      revocation_endpoint: at("/oauth/revoke"),
      introspection_endpoint: at("/oauth/introspect"),
      jwks_uri: at("/.well-known/jwks.json"),
      end_session_endpoint: at("/logout"),
    };
  }

  /** Puts every answer back to its default. The request log lives on the hub. */
  reset(): void {
    this.state = {
      token: () => jsonResponse(200, { access_token: this.accessToken(), token_type: "Bearer" }),
      introspect: () => jsonResponse(200, { active: false }),
      revoke: () => new Response(null, { status: 200 }),
      down: false,
      discovery: this.defaultDiscovery(),
    };
  }

  private handle(request: UpstreamRequest): Response | Promise<Response> {
    if (this.state.down) return new Response(null, { status: 503 });
    switch (request.path) {
      case "/.well-known/openid-configuration":
        return jsonResponse(200, this.state.discovery);
      case "/.well-known/jwks.json":
        return jsonResponse(200, { keys: [this.jwk] });
      case "/oauth/token":
        return this.state.token(request.form, request);
      case "/oauth/introspect":
        return this.state.introspect(request.form, request);
      case "/oauth/revoke":
        return this.state.revoke(request.form, request);
    }
    return jsonResponse(404, { error: "not_found" });
  }

  /** Stops accepting connections, the way an unreachable provider looks; `false` brings it back. */
  setUnreachable(unreachable: boolean): void {
    if (unreachable === this.unreachable) return;
    this.unreachable = unreachable;
    if (unreachable) this.server.stop(true);
    else this.server = this.listen(this.port);
  }

  /** The requests for `path`, over the back channel or at the issuer's own host. */
  seen(path: string): UpstreamRequest[] {
    return this.hub.requests.filter(
      (request) => (request.host === ISSUER_HOST || request.host === ISSUER_PUBLIC_HOST) && request.path === path,
    );
  }

  jwt(header: object, payload: object, key: KeyObject = this.privateKey): string {
    const h = Buffer.from(JSON.stringify(header)).toString("base64url");
    const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${h}.${p}.${edSign(null, Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
  }

  accessToken(claims: object = {}, header: object = {}): string {
    return this.jwt(
      { alg: "EdDSA", typ: "at+jwt", kid: "k1", ...header },
      {
        iss: ISSUER,
        sub: "usr_alice",
        aud: CLIENT_ID,
        iat: nowS(),
        exp: nowS() + 600,
        sid: "ses_1",
        username: "alice",
        name: "Alice",
        role: "user",
        ...claims,
      },
    );
  }

  idToken(claims: object = {}, header: object = {}): string {
    return this.jwt(
      { alg: "EdDSA", typ: "JWT", kid: "k1", ...header },
      {
        iss: ISSUER,
        sub: "usr_alice",
        aud: CLIENT_ID,
        iat: nowS(),
        exp: nowS() + 600,
        auth_time: nowS(),
        email: "alice@example.com",
        email_verified: true,
        ...claims,
      },
    );
  }

  /** A security event token carrying `events`, e.g. `{ "user.disabled": { sub: "usr_alice" } }`. */
  eventToken(events: object, claims: object = {}, header: object = {}): string {
    return this.jwt(
      { alg: "EdDSA", typ: "secevent+jwt", kid: "k1", ...header },
      { iss: ISSUER, aud: CLIENT_ID, iat: nowS(), jti: `evt_${crypto.randomUUID()}`, events, ...claims },
    );
  }

  /** A token signed by a key the provider never published. */
  foreignKeyToken(payload: object, header: object): string {
    return this.jwt(header, payload, generateKeyPairSync("ed25519").privateKey);
  }

  stop(): void {
    this.server.stop(true);
  }
}
