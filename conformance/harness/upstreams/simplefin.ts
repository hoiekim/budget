/**
 * A SimpleFin bridge, as a stateful fake (https://www.simplefin.org/protocol.html).
 *
 * A connection is what a user links at the bridge: Basic credentials, the
 * accounts with their transactions and holdings, and the errors the bridge
 * reports with them. `setupToken(connection)` is what the user pastes into
 * the app: the base64 of a claim URL on `SIMPLEFIN_CLAIM_HOST`. Claiming it
 * (a POST) answers the connection's access URL
 * (`https://<user>:<password>@bridge.simplefin.test/simplefin`) once; a second
 * claim answers 403, as a real bridge does. `GET <access URL>/accounts`
 * answers the accounts, each with the transactions posted in
 * `[start-date, end-date)` (pending ones only with `pending=1`), only the
 * accounts `account` names when given, under the connection's Basic
 * credentials (403 otherwise).
 *
 *   const connection = stack.upstream.simplefin.addConnection({ accounts: [simpleFinAccount({ id: "ACT-1" })] });
 *   const token = stack.upstream.simplefin.setupToken(connection);
 *   stack.upstream.simplefin.fail("/simplefin/accounts", { status: 500 }, { times: 1 });
 *   stack.upstream.simplefin.fail("/claim", { redirect: "https://169.254.169.254/latest" });
 *
 * Tests may still override any path with `hub.on(SIMPLEFIN_HOST, …)`.
 */
import crypto from "node:crypto";
import { jsonResponse, type UpstreamHub, type UpstreamRequest } from "./hub";

export const SIMPLEFIN_HOST = "bridge.simplefin.test";
export const SIMPLEFIN_CLAIM_HOST = "claim.simplefin.test";

type Json = Record<string, unknown>;

/** A SimpleFin organization. */
export const simpleFinOrg = (overrides: Json = {}): Json => ({
  domain: "bank.example.com",
  id: "org-fake-bank",
  name: "Fake Bank",
  "sfin-url": `https://${SIMPLEFIN_HOST}/simplefin`,
  url: "https://bank.example.com",
  ...overrides,
});

/** A SimpleFin transaction; `posted` and `transacted_at` are epoch seconds. */
export const simpleFinTransaction = (overrides: Json = {}): Json => ({
  amount: "-12.50",
  description: "Fake Coffee",
  id: `TRN-${crypto.randomUUID()}`,
  memo: "",
  payee: "Fake Coffee Shop",
  posted: Math.floor(Date.now() / 1000) - 86_400,
  transacted_at: Math.floor(Date.now() / 1000) - 86_400,
  ...overrides,
});

/** A SimpleFin holding; `created` is epoch seconds. */
export const simpleFinHolding = (overrides: Json = {}): Json => ({
  cost_basis: "900.00",
  created: Math.floor(Date.now() / 1000) - 86_400,
  currency: "USD",
  description: "Fake Index Fund",
  id: `HOL-${crypto.randomUUID()}`,
  market_value: "1000.00",
  purchase_price: "90.00",
  shares: "10",
  symbol: "FAKE",
  ...overrides,
});

/** A SimpleFin account, with no transactions or holdings unless given. */
export const simpleFinAccount = (overrides: Json = {}): Json => ({
  "available-balance": "100.00",
  balance: "110.00",
  "balance-date": Math.floor(Date.now() / 1000),
  currency: "USD",
  holdings: [],
  id: `ACT-${crypto.randomUUID()}`,
  name: "Fake Checking",
  org: simpleFinOrg(),
  transactions: [],
  ...overrides,
});

export interface SimpleFinConnection {
  username: string;
  password: string;
  accounts: Json[];
  /** What the bridge lists under `errors`. */
  errors: unknown[];
  /** The access URL claiming its setup token answers. */
  accessUrl: string;
}

/**
 * How a scripted request fails: an HTTP status with a body of its own, or a
 * redirect to `redirect`.
 */
export type SimpleFinFailure = { status: number; body?: string; contentType?: string } | { redirect: string; status?: number };

interface ScriptedFailure {
  path: string;
  failure: SimpleFinFailure;
  remaining: number;
}

interface Claim {
  connection: SimpleFinConnection;
  claimed: boolean;
}

export class FakeSimpleFin {
  /** Connections by username. */
  readonly connections = new Map<string, SimpleFinConnection>();
  private readonly claims = new Map<string, Claim>();
  private readonly failures: ScriptedFailure[] = [];

  constructor(private readonly hub: UpstreamHub) {
    hub.on(SIMPLEFIN_CLAIM_HOST, (request) => this.answerClaim(request));
    hub.on(SIMPLEFIN_HOST, (request) => this.answerBridge(request));
  }

  seen(path = ""): UpstreamRequest[] {
    return this.hub.requests.filter(
      (r) => (r.host === SIMPLEFIN_HOST || r.host === SIMPLEFIN_CLAIM_HOST) && r.path.startsWith(path),
    );
  }

  /** Adds a connection; credentials are generated unless given. */
  addConnection(init: Partial<Omit<SimpleFinConnection, "accessUrl">> = {}): SimpleFinConnection {
    const username = init.username ?? `user-${crypto.randomUUID()}`;
    const password = init.password ?? `secret-${crypto.randomUUID()}`;
    const connection: SimpleFinConnection = {
      username,
      password,
      accounts: init.accounts ?? [],
      errors: init.errors ?? [],
      accessUrl: `https://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${SIMPLEFIN_HOST}/simplefin`,
    };
    this.connections.set(username, connection);
    return connection;
  }

  /** A new one-time setup token for `connection`: the base64 of its claim URL. */
  setupToken(connection: SimpleFinConnection): string {
    const claim = crypto.randomUUID();
    this.claims.set(claim, { connection, claimed: false });
    return Buffer.from(`https://${SIMPLEFIN_CLAIM_HOST}/claim/${claim}`).toString("base64");
  }

  /** The base64 setup token of an arbitrary claim URL, for URLs the allowlist must refuse. */
  static setupTokenFor(url: string): string {
    return Buffer.from(url).toString("base64");
  }

  /**
   * Makes requests whose path starts with `path` (`/claim`, `/simplefin/accounts`)
   * fail with `failure`, the next `times` of them (every one by default).
   * Returns the function that removes the script.
   */
  fail(path: string, failure: SimpleFinFailure, { times = Infinity }: { times?: number } = {}): () => void {
    const scripted: ScriptedFailure = { path, failure, remaining: times };
    this.failures.unshift(scripted);
    return () => {
      const at = this.failures.indexOf(scripted);
      if (at !== -1) this.failures.splice(at, 1);
    };
  }

  /** The bridge and the claim host drop their connections until set back. */
  unreachable(isDown = true): void {
    this.hub.setDown(SIMPLEFIN_HOST, isDown);
    this.hub.setDown(SIMPLEFIN_CLAIM_HOST, isDown);
  }

  private failure(request: UpstreamRequest): Response | undefined {
    const scripted = this.failures.find((f) => f.remaining > 0 && request.path.startsWith(f.path));
    if (!scripted) return undefined;
    scripted.remaining -= 1;
    const { failure } = scripted;
    if ("redirect" in failure) return new Response(null, { status: failure.status ?? 302, headers: { Location: failure.redirect } });
    return new Response(failure.body ?? "", {
      status: failure.status,
      headers: failure.contentType ? { "Content-Type": failure.contentType } : {},
    });
  }

  private answerClaim(request: UpstreamRequest): Response | undefined {
    const match = /^\/claim\/([^/]+)$/.exec(request.path);
    if (!match) return undefined;
    const failed = this.failure(request);
    if (failed) return failed;
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const claim = this.claims.get(match[1]);
    if (!claim || claim.claimed) return new Response("Forbidden", { status: 403 });
    claim.claimed = true;
    return new Response(claim.connection.accessUrl, { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  private connectionOf(request: UpstreamRequest): SimpleFinConnection | undefined {
    const match = /^Basic (.+)$/.exec(request.headers.authorization ?? "");
    if (!match) return undefined;
    const decoded = Buffer.from(match[1], "base64").toString();
    const colon = decoded.indexOf(":");
    if (colon === -1) return undefined;
    const connection = this.connections.get(decoded.slice(0, colon));
    return connection && connection.password === decoded.slice(colon + 1) ? connection : undefined;
  }

  private answerBridge(request: UpstreamRequest): Response | undefined {
    if (request.path !== "/simplefin/accounts") return undefined;
    const failed = this.failure(request);
    if (failed) return failed;
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    const connection = this.connectionOf(request);
    if (!connection) return new Response("Forbidden", { status: 403 });

    const params = new URLSearchParams(request.search);
    const start = params.has("start-date") ? Number(params.get("start-date")) : -Infinity;
    const end = params.has("end-date") ? Number(params.get("end-date")) : Infinity;
    const pending = params.get("pending") === "1";
    const wanted = params.getAll("account");
    const accounts = connection.accounts
      .filter((account) => wanted.length === 0 || wanted.includes(String(account.id)))
      .map((account) => ({
        ...account,
        transactions: ((account.transactions ?? []) as Json[]).filter((t) => {
          const posted = Number(t.posted);
          return posted >= start && posted < end && (pending || !t.pending);
        }),
      }));
    return jsonResponse(200, { errors: connection.errors, accounts });
  }
}
