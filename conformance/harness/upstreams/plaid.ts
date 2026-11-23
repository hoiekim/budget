/**
 * Plaid's API, as a stateful fake answering every Plaid environment
 * (production, development, sandbox). It keeps items by access token, each
 * with its accounts, holdings, securities, transaction-sync pages and
 * investment transactions; institutions by id; public tokens waiting to be
 * exchanged; and webhook verification keys. Requests are answered the way
 * Plaid answers them: a JSON body, or on failure HTTP 400 (500 for an API
 * error, 429 for a rate limit) with Plaid's error body.
 *
 * Defaults: every call needs a `PLAID-CLIENT-ID` and a `PLAID-SECRET` header
 * (`INVALID_API_KEYS` otherwise); an access token no item has answers
 * `INVALID_ACCESS_TOKEN`; an unknown institution `INVALID_INSTITUTION`; an
 * unknown public token `INVALID_PUBLIC_TOKEN`; an unknown webhook key id
 * `INVALID_WEBHOOK_VERIFICATION_KEY_ID`. Link tokens are always issued.
 *
 *   const item = stack.upstream.plaid.addItem({ accounts: [plaidAccount({ account_id: "a-1" })] });
 *   stack.upstream.plaid.fail("/accounts/get", { error_code: "ITEM_LOGIN_REQUIRED" }, { times: 1 });
 *   stack.upstream.plaid.calls("/item/remove")  // what the server sent
 *
 * Tests may still override any path with `hub.on(PLAID_PRODUCTION_HOST, …)`:
 * the newest handler is asked first.
 *
 * An unreachable Plaid (`unreachable()`) drops every connection. The Bun
 * server's Plaid SDK (axios through the proxy) never settles such a call, so
 * a request waiting on one only ends when Bun's idle timeout closes it.
 */
import crypto from "node:crypto";
import { jsonResponse, type UpstreamHub, type UpstreamRequest } from "./hub";

export const PLAID_PRODUCTION_HOST = "production.plaid.com";
export const PLAID_DEVELOPMENT_HOST = "development.plaid.com";
export const PLAID_SANDBOX_HOST = "sandbox.plaid.com";
export const PLAID_HOSTS = [PLAID_PRODUCTION_HOST, PLAID_DEVELOPMENT_HOST, PLAID_SANDBOX_HOST] as const;
export type PlaidHost = (typeof PLAID_HOSTS)[number];

/** Every `request_id` the fake answers with. */
export const PLAID_REQUEST_ID = "conformance-plaid-request";

type Json = Record<string, unknown>;

/** The `error_type` Plaid files each error code under. */
const ERROR_TYPES: Record<string, string> = {
  ITEM_LOGIN_REQUIRED: "ITEM_ERROR",
  PRODUCTS_NOT_SUPPORTED: "ITEM_ERROR",
  NO_INVESTMENT_ACCOUNTS: "ITEM_ERROR",
  NO_ACCOUNTS: "ITEM_ERROR",
  PRODUCT_NOT_READY: "ITEM_ERROR",
  ITEM_NOT_FOUND: "ITEM_ERROR",
  INVALID_ACCESS_TOKEN: "INVALID_INPUT",
  INVALID_PUBLIC_TOKEN: "INVALID_INPUT",
  INVALID_INSTITUTION: "INVALID_INPUT",
  INVALID_API_KEYS: "INVALID_INPUT",
  INVALID_WEBHOOK_VERIFICATION_KEY_ID: "INVALID_INPUT",
  INVALID_FIELD: "INVALID_REQUEST",
  MISSING_FIELDS: "INVALID_REQUEST",
  INSTITUTION_NOT_FOUND: "INVALID_INPUT",
  INSTITUTION_DOWN: "INSTITUTION_ERROR",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION: "TRANSACTIONS_ERROR",
  INTERNAL_SERVER_ERROR: "API_ERROR",
};

const STATUS_OF_TYPE: Record<string, number> = { API_ERROR: 500, RATE_LIMIT_EXCEEDED: 429 };

/** Plaid's error body for `error_code`, filed under its usual `error_type` unless one is given. */
export const plaidErrorBody = (
  error_code: string,
  { error_type = ERROR_TYPES[error_code] ?? "API_ERROR", error_message = `fake ${error_code}` }: { error_type?: string; error_message?: string } = {},
): Json => ({
  display_message: null,
  documentation_url: `https://plaid.com/docs/errors/#${error_code.toLowerCase()}`,
  error_code,
  error_message,
  error_type,
  request_id: PLAID_REQUEST_ID,
  suggested_action: null,
});

/**
 * How a scripted call fails: Plaid's error answer for `error_code` (HTTP 400,
 * or the status its type takes, or `status`), or a bare HTTP failure with a
 * body of its own (`body` text, empty by default).
 */
export type PlaidFailure =
  | { error_code: string; error_type?: string; error_message?: string; status?: number }
  | { status: number; body?: string; contentType?: string };

/** A Plaid account (`AccountBase`), with every field filled. */
export const plaidAccount = (overrides: Json = {}): Json => ({
  account_id: `acc-${crypto.randomUUID()}`,
  balances: { available: 100, current: 110, iso_currency_code: "USD", limit: null, unofficial_currency_code: null },
  mask: "0000",
  name: "Plaid Checking",
  official_name: "Plaid Gold Standard 0% Interest Checking",
  persistent_account_id: null,
  subtype: "checking",
  type: "depository",
  ...overrides,
});

/** A Plaid institution, with every field `institutions/get_by_id` answers. */
export const plaidInstitution = (institution_id: string, overrides: Json = {}): Json => ({
  country_codes: ["US"],
  institution_id,
  logo: null,
  name: `Institution ${institution_id}`,
  oauth: false,
  primary_color: "#1f1f1f",
  products: ["assets", "auth", "balance", "transactions", "investments"],
  routing_numbers: ["011000138"],
  status: null,
  url: `https://${institution_id}.example.com`,
  ...overrides,
});

/** A Plaid transaction, as `transactions/sync` lists it. */
export const plaidTransaction = (overrides: Json = {}): Json => ({
  account_id: "acc-1",
  account_owner: null,
  amount: 12.5,
  authorized_date: "2026-03-01",
  authorized_datetime: null,
  category: ["Food and Drink", "Restaurants"],
  category_id: "13005000",
  check_number: null,
  date: "2026-03-02",
  datetime: null,
  iso_currency_code: "USD",
  location: { address: null, city: null, country: null, lat: null, lon: null, postal_code: null, region: null, store_number: null },
  merchant_name: "Fake Merchant",
  name: "FAKE MERCHANT 123",
  payment_channel: "in store",
  payment_meta: {
    by_order_of: null,
    payee: null,
    payer: null,
    payment_method: null,
    payment_processor: null,
    ppd_id: null,
    reason: null,
    reference_number: null,
  },
  pending: false,
  pending_transaction_id: null,
  transaction_code: null,
  transaction_id: `tx-${crypto.randomUUID()}`,
  transaction_type: "place",
  unofficial_currency_code: null,
  ...overrides,
});

/** A Plaid security. */
export const plaidSecurity = (overrides: Json = {}): Json => ({
  close_price: 100,
  close_price_as_of: "2026-03-01",
  cusip: null,
  institution_id: null,
  institution_security_id: null,
  is_cash_equivalent: false,
  isin: null,
  iso_currency_code: "USD",
  market_identifier_code: null,
  name: "Fake Index Fund",
  proxy_security_id: null,
  security_id: `sec-${crypto.randomUUID()}`,
  sedol: null,
  ticker_symbol: "FAKE",
  type: "mutual fund",
  unofficial_currency_code: null,
  update_datetime: null,
  ...overrides,
});

/** A Plaid holding. */
export const plaidHolding = (overrides: Json = {}): Json => ({
  account_id: "acc-1",
  cost_basis: 900,
  institution_price: 100,
  institution_price_as_of: "2026-03-01",
  institution_value: 1000,
  iso_currency_code: "USD",
  quantity: 10,
  security_id: "sec-1",
  unofficial_currency_code: null,
  ...overrides,
});

/** A Plaid investment transaction. */
export const plaidInvestmentTransaction = (overrides: Json = {}): Json => ({
  account_id: "acc-1",
  amount: 1000,
  cancel_transaction_id: null,
  date: "2026-03-01",
  fees: 0,
  investment_transaction_id: `inv-${crypto.randomUUID()}`,
  iso_currency_code: "USD",
  name: "BUY FAKE",
  price: 100,
  quantity: 10,
  security_id: "sec-1",
  subtype: "buy",
  type: "buy",
  unofficial_currency_code: null,
  ...overrides,
});

/** One page of `transactions/sync`. */
export interface PlaidSyncPage {
  added?: Json[];
  modified?: Json[];
  removed?: Json[];
}

/** An item as Plaid holds it. */
export interface FakePlaidItem {
  item_id: string;
  access_token: string;
  institution_id: string | null;
  /** Billed products. */
  products: string[];
  available_products: string[];
  webhook: string | null;
  /** The environment the item lives in; `undefined` answers on every one. */
  host?: PlaidHost;
  accounts: Json[];
  holdings: Json[];
  securities: Json[];
  /** `transactions/sync` pages, oldest first. Cursor `""` (or none) is page 0. */
  syncPages: PlaidSyncPage[];
  investmentTransactions: Json[];
}

export interface PlaidCall {
  host: string;
  path: string;
  body: Json;
  headers: Record<string, string>;
}

interface ScriptedFailure {
  endpoint: string;
  failure: PlaidFailure;
  remaining: number;
  accessToken?: string;
  host?: string;
}

const ENVIRONMENT: Record<string, string> = {
  [PLAID_PRODUCTION_HOST]: "production",
  [PLAID_DEVELOPMENT_HOST]: "development",
  [PLAID_SANDBOX_HOST]: "sandbox",
};

const base64url = (value: Buffer | string): string => Buffer.from(value).toString("base64url");

export class FakePlaid {
  /** Items by access token. */
  readonly items = new Map<string, FakePlaidItem>();
  /** Items removed through `item/remove`, oldest first. */
  readonly removedItems: FakePlaidItem[] = [];
  /** Institutions by id. */
  readonly institutions = new Map<string, Json>();
  /** Public tokens waiting to be exchanged, with the item each makes. */
  readonly publicTokens = new Map<string, FakePlaidItem>();
  /** Every link token issued, with the environment and the request that asked for it. */
  readonly linkTokens: { link_token: string; host: string; request: Json }[] = [];
  private readonly failures: ScriptedFailure[] = [];
  private readonly keys = new Map<string, { jwk: Json; privateKey: crypto.KeyObject }>();

  constructor(private readonly hub: UpstreamHub) {
    for (const host of PLAID_HOSTS) hub.on(host, (request) => this.answer(request));
  }

  /** Every request any Plaid environment received, optionally only paths starting with `path`. */
  seen(path = ""): UpstreamRequest[] {
    return this.hub.requests.filter((r) => (PLAID_HOSTS as readonly string[]).includes(r.host) && r.path.startsWith(path));
  }

  /** The calls made to exactly `endpoint` (`/item/remove`), with their parsed bodies. */
  calls(endpoint: string): PlaidCall[] {
    return this.seen()
      .filter((r) => r.path === endpoint)
      .map((r) => ({ host: r.host, path: r.path, body: (r.json ?? {}) as Json, headers: r.headers }));
  }

  /**
   * Adds an item; what is not given is filled: a random id and an
   * `access-<environment>-<uuid>` token, the Transactions product billed and
   * Investments available, no accounts.
   */
  addItem(init: Partial<FakePlaidItem> = {}): FakePlaidItem {
    const item = FakePlaid.newItem(init);
    this.items.set(item.access_token, item);
    return item;
  }

  private static newItem(init: Partial<FakePlaidItem>): FakePlaidItem {
    const environment = init.host ? ENVIRONMENT[init.host] : "production";
    return {
      item_id: `item-${crypto.randomUUID()}`,
      access_token: `access-${environment}-${crypto.randomUUID()}`,
      institution_id: "ins_109508",
      products: ["transactions"],
      available_products: ["investments"],
      webhook: null,
      accounts: [],
      holdings: [],
      securities: [],
      syncPages: [],
      investmentTransactions: [],
      ...init,
    };
  }

  /** Adds an institution `institutions/get_by_id` resolves; see `plaidInstitution`. */
  addInstitution(institution_id: string, overrides: Json = {}): Json {
    const institution = plaidInstitution(institution_id, overrides);
    this.institutions.set(institution_id, institution);
    return institution;
  }

  /**
   * What Link hands the browser when a user connects: a public token that
   * `item/public_token/exchange` turns into the item (added to `items` then).
   */
  createPublicToken(init: Partial<FakePlaidItem> = {}): { public_token: string; item: FakePlaidItem } {
    const item = FakePlaid.newItem(init);
    const public_token = `public-${init.host ? ENVIRONMENT[init.host] : "production"}-${crypto.randomUUID()}`;
    this.publicTokens.set(public_token, item);
    return { public_token, item };
  }

  /** Appends a `transactions/sync` page to the item with `access_token`. */
  addSyncPage(access_token: string, page: PlaidSyncPage): void {
    const item = this.items.get(access_token);
    if (!item) throw new Error(`no fake Plaid item has access token ${access_token}`);
    item.syncPages.push(page);
  }

  /**
   * Makes calls to `endpoint` fail with `failure`: the next `times` of them
   * (every one by default), only those naming `accessToken` or reaching
   * `host` when given. The newest script is consulted first. Returns the
   * function that removes it.
   */
  fail(endpoint: string, failure: PlaidFailure, { times = Infinity, accessToken, host }: { times?: number; accessToken?: string; host?: string } = {}): () => void {
    const scripted: ScriptedFailure = { endpoint, failure, remaining: times, accessToken, host };
    this.failures.unshift(scripted);
    return () => {
      const at = this.failures.indexOf(scripted);
      if (at !== -1) this.failures.splice(at, 1);
    };
  }

  /** Every Plaid environment drops its connections until set back (see the note above). */
  unreachable(isDown = true): void {
    for (const host of PLAID_HOSTS) this.hub.setDown(host, isDown);
  }

  /** Forgets every scripted failure. */
  clearFailures(): void {
    this.failures.length = 0;
  }

  /**
   * Makes an ES256 webhook verification key that `webhook_verification_key/get`
   * answers for `kid`, and returns its public JWK.
   */
  addWebhookKey(kid = `kid-${crypto.randomUUID()}`): { kid: string; jwk: Json } {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const exported = publicKey.export({ format: "jwk" }) as Json;
    const jwk: Json = {
      alg: "ES256",
      created_at: 1_700_000_000,
      crv: "P-256",
      expired_at: null,
      kid,
      kty: "EC",
      use: "sig",
      x: exported.x,
      y: exported.y,
    };
    this.keys.set(kid, { jwk, privateKey });
    return { kid, jwk };
  }

  /**
   * The `Plaid-Verification` header Plaid would send with `body`: an ES256
   * JWT signed by the key `kid` (one `addWebhookKey` made), issued now
   * (`iat`, in seconds, unless given) and carrying the body's SHA-256.
   * `claims` and `header` add to or replace what is signed.
   */
  signWebhook(body: string, { kid, iat, claims = {}, header = {} }: { kid?: string; iat?: number; claims?: Json; header?: Json } = {}): string {
    const keyId = kid ?? [...this.keys.keys()].at(-1);
    const key = keyId === undefined ? undefined : this.keys.get(keyId);
    if (!key) throw new Error("signWebhook needs a key: call addWebhookKey first");
    const protectedHeader = { alg: "ES256", kid: keyId, typ: "JWT", ...header };
    const payload = {
      iat: iat ?? Math.floor(Date.now() / 1000),
      request_body_sha256: crypto.createHash("sha256").update(body).digest("hex"),
      ...claims,
    };
    const input = `${base64url(JSON.stringify(protectedHeader))}.${base64url(JSON.stringify(payload))}`;
    const signature = crypto.sign("sha256", Buffer.from(input), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
    return `${input}.${base64url(signature)}`;
  }

  private failure(request: UpstreamRequest): Response | undefined {
    const body = (request.json ?? {}) as Json;
    const scripted = this.failures.find(
      (f) =>
        f.remaining > 0 &&
        f.endpoint === request.path &&
        (f.accessToken === undefined || body.access_token === f.accessToken) &&
        (f.host === undefined || f.host === request.host),
    );
    if (!scripted) return undefined;
    scripted.remaining -= 1;
    const { failure } = scripted;
    if ("error_code" in failure) {
      const errorBody = plaidErrorBody(failure.error_code, failure);
      return jsonResponse(failure.status ?? STATUS_OF_TYPE[errorBody.error_type as string] ?? 400, errorBody);
    }
    return new Response(failure.body ?? "", {
      status: failure.status,
      headers: failure.contentType ? { "Content-Type": failure.contentType } : {},
    });
  }

  private error(error_code: string): Response {
    const body = plaidErrorBody(error_code);
    return jsonResponse(STATUS_OF_TYPE[body.error_type as string] ?? 400, body);
  }

  private itemOf(request: UpstreamRequest): FakePlaidItem | undefined {
    const token = (request.json as Json | undefined)?.access_token;
    const item = typeof token === "string" ? this.items.get(token) : undefined;
    return item && (item.host === undefined || item.host === request.host) ? item : undefined;
  }

  private static itemJson(item: FakePlaidItem): Json {
    return {
      available_products: item.available_products,
      billed_products: item.products,
      consent_expiration_time: null,
      error: null,
      institution_id: item.institution_id,
      item_id: item.item_id,
      products: item.products,
      update_type: "background",
      webhook: item.webhook,
    };
  }

  private answer(request: UpstreamRequest): Response | undefined {
    if (request.method !== "POST") return undefined;
    if (!request.headers["plaid-client-id"] || !request.headers["plaid-secret"]) return this.error("INVALID_API_KEYS");
    const failed = this.failure(request);
    if (failed) return failed;

    const body = (request.json ?? {}) as Json;
    const ok = (data: Json) => jsonResponse(200, { ...data, request_id: PLAID_REQUEST_ID });

    switch (request.path) {
      case "/link/token/create": {
        if (body.access_token !== undefined && !this.itemOf(request)) return this.error("INVALID_ACCESS_TOKEN");
        const link_token = `link-${ENVIRONMENT[request.host]}-${crypto.randomUUID()}`;
        this.linkTokens.push({ link_token, host: request.host, request: body });
        return ok({ expiration: new Date(Date.now() + 4 * 3_600_000).toISOString(), link_token });
      }
      case "/item/public_token/exchange": {
        const item = typeof body.public_token === "string" ? this.publicTokens.get(body.public_token) : undefined;
        if (!item) return this.error("INVALID_PUBLIC_TOKEN");
        this.publicTokens.delete(body.public_token as string);
        this.items.set(item.access_token, item);
        return ok({ access_token: item.access_token, item_id: item.item_id });
      }
      case "/item/get": {
        const item = this.itemOf(request);
        if (!item) return this.error("INVALID_ACCESS_TOKEN");
        return ok({ item: FakePlaid.itemJson(item), status: { transactions: null, investments: null, last_webhook: null } });
      }
      case "/item/remove": {
        const item = this.itemOf(request);
        if (!item) return this.error("INVALID_ACCESS_TOKEN");
        this.items.delete(item.access_token);
        this.removedItems.push(item);
        return ok({});
      }
      case "/accounts/get":
      case "/accounts/balance/get": {
        const item = this.itemOf(request);
        if (!item) return this.error("INVALID_ACCESS_TOKEN");
        return ok({ accounts: item.accounts, item: FakePlaid.itemJson(item) });
      }
      case "/institutions/get_by_id": {
        const institution = typeof body.institution_id === "string" ? this.institutions.get(body.institution_id) : undefined;
        if (!institution) return this.error("INVALID_INSTITUTION");
        return ok({ institution });
      }
      case "/transactions/sync": {
        const item = this.itemOf(request);
        if (!item) return this.error("INVALID_ACCESS_TOKEN");
        const cursor = body.cursor === undefined || body.cursor === null || body.cursor === "" ? "cursor-0" : body.cursor;
        const match = typeof cursor === "string" ? /^cursor-(\d+)$/.exec(cursor) : null;
        if (!match) return this.error("INVALID_FIELD");
        const index = Number(match[1]);
        const page = item.syncPages[index];
        const next = page ? index + 1 : index;
        return ok({
          accounts: item.accounts,
          added: page?.added ?? [],
          has_more: next < item.syncPages.length,
          modified: page?.modified ?? [],
          next_cursor: `cursor-${next}`,
          removed: page?.removed ?? [],
          transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
        });
      }
      case "/investments/holdings/get": {
        const item = this.itemOf(request);
        if (!item) return this.error("INVALID_ACCESS_TOKEN");
        if (![...item.products, ...item.available_products].includes("investments")) return this.error("PRODUCTS_NOT_SUPPORTED");
        if (!item.accounts.some((account) => account.type === "investment")) return this.error("NO_INVESTMENT_ACCOUNTS");
        return ok({ accounts: item.accounts, holdings: item.holdings, item: FakePlaid.itemJson(item), securities: item.securities });
      }
      case "/investments/transactions/get": {
        const item = this.itemOf(request);
        if (!item) return this.error("INVALID_ACCESS_TOKEN");
        if (![...item.products, ...item.available_products].includes("investments")) return this.error("PRODUCTS_NOT_SUPPORTED");
        if (!item.accounts.some((account) => account.type === "investment")) return this.error("NO_INVESTMENT_ACCOUNTS");
        const { start_date, end_date } = body as { start_date?: string; end_date?: string };
        if (typeof start_date !== "string" || typeof end_date !== "string") return this.error("MISSING_FIELDS");
        const options = (body.options ?? {}) as { count?: number; offset?: number };
        const count = options.count ?? 100;
        const offset = options.offset ?? 0;
        const inWindow = item.investmentTransactions.filter((t) => String(t.date) >= start_date && String(t.date) <= end_date);
        return ok({
          accounts: item.accounts,
          investment_transactions: inWindow.slice(offset, offset + count),
          item: FakePlaid.itemJson(item),
          securities: item.securities,
          total_investment_transactions: inWindow.length,
        });
      }
      case "/webhook_verification_key/get": {
        const key = typeof body.key_id === "string" ? this.keys.get(body.key_id) : undefined;
        if (!key) return this.error("INVALID_WEBHOOK_VERIFICATION_KEY_ID");
        return ok({ key: key.jwk });
      }
      default:
        return undefined;
    }
  }
}
