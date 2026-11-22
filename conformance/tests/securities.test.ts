/**
 * Securities: `GET /securities` and `POST /validate-ticker`, which looks a
 * ticker up at Polygon (falling back to Yahoo) and stores what it finds.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUserClient, startStack, urlsOf, type ApiClient, type RequestOptions, type Stack } from "../harness";
import { polygonAnswer } from "../harness/upstreams/polygon";
import { yahooAnswer } from "../harness/upstreams/yahoo";
import { seedApiKey } from "../harness/seed/budgets";
import { localDay, seedAccount, seedHolding, seedSecurity, seedSnapshot, shareData, softDelete, storedRow, storedRows, withoutStamps } from "../harness/seed/snapshots";

const stacks: Stack[] = [];
let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
  stacks.push(stack);
});
afterAll(async () => {
  await Promise.all(stacks.map((s) => s.stop()));
});

const POLYGON_KEY = "conformance-polygon-key";
const DAY = 86_400_000;
const SERVER_ERROR = { status: "error", message: "Internal server error" };
const failed = (message: string) => ({ status: "failed", message });
const SHED = failed("Too many ticker lookups, try again in a minute.");
const TICKER_MESSAGE = "Ticker symbol must be 1-16 characters of A-Z, 0-9, '.', '-' or ':'";
const MINTED_ID = /^[0-9a-f]{5}$/;

/**
 * A security the server mints from a lookup gets a random five-digit id, so
 * an answer that carries one is left out of the cross-server comparison; the
 * test still asserts its shape and what was stored.
 */
const MINTS_AN_ID: RequestOptions = { noCompare: true };

const detailUrl = (ticker: string) => `GET /v3/reference/tickers/${ticker}?apiKey=${POLYGON_KEY}`;
const aggsUrl = (ticker: string, day: string) => `GET /v2/aggs/ticker/${ticker}/range/1/day/${day}/${day}?apiKey=${POLYGON_KEY}`;
const yahooDetailUrl = (ticker: string) => `GET /v8/finance/chart/${ticker}?interval=1d&range=5d`;
const yahooPriceUrl = (ticker: string, day: string) => {
  const target = Date.parse(`${day}T00:00:00Z`);
  return `GET /v8/finance/chart/${ticker}?interval=1d&period1=${Math.floor((target - DAY) / 1000)}&period2=${Math.floor((target + 2 * DAY) / 1000)}`;
};

interface Person {
  client: ApiClient;
  user_id: string;
}

let counter = 0;
const person = async (name: string, on = stack): Promise<Person> => {
  const { client, user } = await createUserClient(on, `${name}-${++counter}`);
  return { client, user_id: user.user_id };
};

/** A ticker no other test uses: the market-data clients keep what they learn for an hour. */
let tickers = 0;
const ticker = (stem: string) => `${stem}${++tickers}`;

const RAW_FIELDS = ["sedol", "institution_security_id", "institution_id", "proxy_security_id", "is_cash_equivalent", "unofficial_currency_code", "market_identifier_code", "sector", "industry", "option_contract", "fixed_income"];

/** A securities row as the API lists it: the columns, then the fields kept in `raw`. */
const securityJson = (row: Record<string, unknown>, raw: Record<string, unknown> = {}) => ({
  security_id: row.security_id,
  name: row.name ?? null,
  ticker_symbol: row.ticker_symbol ?? null,
  type: row.type ?? null,
  close_price: row.close_price ?? null,
  close_price_as_of: row.close_price_as_of ?? null,
  iso_currency_code: row.iso_currency_code ?? null,
  isin: row.isin ?? null,
  cusip: row.cusip ?? null,
  ...Object.fromEntries(RAW_FIELDS.map((field) => [field, raw[field] ?? null])),
});

/** The security a lookup answers: what the detail and the price gave, the rest null. */
const lookedUp = (symbol: string, name: string | undefined, currency: string, close_price: number | null) => {
  const security: Record<string, unknown> = {
    security_id: expect.stringMatching(MINTED_ID),
    ticker_symbol: symbol,
    name,
    iso_currency_code: currency,
    close_price,
    close_price_as_of: close_price === null ? null : `${localDay(new Date())}T00:00:00`,
  };
  if (name === undefined) delete security.name;
  for (const key of ["isin", "cusip", "sedol", "institution_security_id", "institution_id", "proxy_security_id", "is_cash_equivalent", "type", "update_datetime", "unofficial_currency_code", "market_identifier_code", "sector", "industry", "option_contract", "fixed_income"]) {
    security[key] = null;
  }
  return security;
};

/** The row a looked-up security is stored as: its columns, and the whole answer in `raw`. */
const storedLookup = (security: Record<string, unknown>) => ({
  security_id: security.security_id,
  name: security.name ?? null,
  ticker_symbol: security.ticker_symbol,
  type: null,
  close_price: security.close_price,
  close_price_as_of: security.close_price_as_of === null ? null : localDay(new Date()),
  iso_currency_code: security.iso_currency_code,
  isin: null,
  cusip: null,
  raw: security,
});

const validate = <T = { valid: boolean; security?: Record<string, unknown>; message?: string }>(client: ApiClient, body: unknown, options: RequestOptions = {}) =>
  client.post<T>("/validate-ticker", body, options);

describe("a caller without a session", () => {
  test("is refused on both routes, with an API key as well", async () => {
    const anonymous = stack.anonymous();
    const owner = await person("sec-anon");
    const key = await seedApiKey(stack, owner.user_id, ["transactions:suggest", "budgets:read", "budgets:write"]);
    for (const [method, path, body] of [
      ["GET", "/securities"],
      ["POST", "/validate-ticker", { ticker_symbol: "VOO" }],
    ] as const) {
      for (const headers of [{}, { Authorization: `Bearer ${key}`, "X-Real-IP": "10.43.0.1" }] as Record<string, string>[]) {
        const result = await anonymous.request(method, path, { body, headers });
        expect([method, path, result.status]).toEqual([method, path, 401]);
        expect(result.json).toEqual(failed("Not authenticated."));
      }
    }
    expect(stack.upstream.polygon.about("VOO", "detail")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /securities
// ---------------------------------------------------------------------------

describe("GET /securities", () => {
  test("lists each security the caller or the sharing group holds or held, once", async () => {
    const [owner, member, stranger] = [await person("sec-owner"), await person("sec-member"), await person("sec-stranger")];
    await shareData(stack, owner.user_id, member.user_id);
    const n = counter;
    const accounts = {
      owner: await seedAccount(stack, owner.user_id, `sec-own-${n}`),
      owner2: await seedAccount(stack, owner.user_id, `sec-own2-${n}`),
      member: await seedAccount(stack, member.user_id, `sec-mem-${n}`),
      stranger: await seedAccount(stack, stranger.user_id, `sec-str-${n}`),
    };
    const raw = { sedol: "B0YBKJ7", is_cash_equivalent: true, sector: "Finance", institution_id: "ins_1", unlisted: "x" };
    const rows = {
      held: { security_id: `s${n}-held`, name: "Held Fund", ticker_symbol: "HELD", type: "etf", close_price: 101.5, close_price_as_of: "2026-01-05", iso_currency_code: "USD", isin: "US0000000001", cusip: "000000001" },
      twice: { security_id: `s${n}-twice`, ticker_symbol: "TWICE" },
      sold: { security_id: `s${n}-sold`, name: "Sold", ticker_symbol: "SOLD", type: "equity" },
      members: { security_id: `s${n}-members`, name: "Member's", ticker_symbol: null },
      strangers: { security_id: `s${n}-strangers`, ticker_symbol: "STR" },
      unheld: { security_id: `s${n}-unheld`, ticker_symbol: "UNHELD" },
    };
    await seedSecurity(stack, rows.held.security_id, { ...rows.held, raw });
    for (const row of [rows.twice, rows.sold, rows.members, rows.strangers, rows.unheld]) await seedSecurity(stack, row.security_id, row);
    await seedHolding(stack, owner.user_id, accounts.owner, rows.held.security_id, { quantity: 1 });
    await seedHolding(stack, owner.user_id, accounts.owner, rows.twice.security_id, { quantity: 1 });
    await seedHolding(stack, owner.user_id, accounts.owner2, rows.twice.security_id, { quantity: 2 });
    const sold = await seedHolding(stack, owner.user_id, accounts.owner, rows.sold.security_id, { quantity: 0 });
    await softDelete(stack, "holdings", sold);
    await seedHolding(stack, member.user_id, accounts.member, rows.members.security_id, { quantity: 3 });
    await seedHolding(stack, stranger.user_id, accounts.stranger, rows.strangers.security_id, { quantity: 4 });
    // A holding of a security with no row lists nothing.
    await seedHolding(stack, owner.user_id, accounts.owner, `s${n}-gone`, { quantity: 5 });

    const sorted = (list: unknown): unknown[] => [...(list as { security_id: string }[])].sort((a, b) => (a.security_id < b.security_id ? -1 : 1));
    const group = [securityJson(rows.held, raw), securityJson(rows.members), securityJson(rows.sold), securityJson(rows.twice)];
    for (const client of [owner.client, member.client]) {
      const result = await client.get("/securities");
      expect(result.status).toBe(200);
      expect(result.json.status).toBe("success");
      expect(sorted(result.body)).toEqual(group);
    }
    expect((await stranger.client.get("/securities")).json).toEqual({ status: "success", body: [securityJson(rows.strangers)] });
    expect((await (await person("sec-nobody")).client.get("/securities")).json).toEqual({ status: "success", body: [] });
  });
});

// ---------------------------------------------------------------------------
// POST /validate-ticker
// ---------------------------------------------------------------------------

describe("POST /validate-ticker", () => {
  test("needs a ticker symbol of 1-16 characters of A-Z, 0-9, '.', '-' or ':'", async () => {
    const owner = await person("vt-body");
    const cases: [unknown, string][] = [
      [null, "Request body is required"],
      [[], "Request body must be an object"],
      ["VOO", "Request body must be an object"],
      [{}, "Missing required field: ticker_symbol"],
      [{ ticker_symbol: null }, "Missing required field: ticker_symbol"],
      [{ ticker: "VOO" }, "Missing required field: ticker_symbol"],
      ...[5, true, ["VOO"], {}].map((ticker_symbol): [unknown, string] => [{ ticker_symbol }, "Field ticker_symbol must be a string"]),
      ...["", " ", "\t\n", "VO O", "VOO!", "V/O", "ÅÄÖ", "ABCDEFGHIJKLMNOPQ", "  ABCDEFGHIJKLMNOPQ "].map((ticker_symbol): [unknown, string] => [{ ticker_symbol }, TICKER_MESSAGE]),
    ];
    for (const [body, message] of cases) {
      const result = await validate(owner.client, body);
      expect([body, result.status, result.json]).toEqual([body, 200, failed(message)]);
    }
    expect((await owner.client.request("POST", "/validate-ticker")).json).toEqual(failed("Request body is required"));
  });

  test("answers a stored security without a lookup, the most recently written of a shared ticker", async () => {
    const owner = await person("vt-stored");
    const symbol = ticker("STORED");
    const older = { security_id: `${symbol}-older`, ticker_symbol: symbol, name: "Older", type: "etf" };
    const newer = { security_id: `${symbol}-newer`, ticker_symbol: symbol, name: "Newer", type: "etf", close_price: 12.5, close_price_as_of: "2026-01-02", iso_currency_code: "USD" };
    await seedSecurity(stack, newer.security_id, { ...newer, raw: { sector: "Tech" }, updated: "2026-01-02T00:00:00Z" });
    await seedSecurity(stack, older.security_id, { ...older, updated: "2026-01-01T00:00:00Z" });
    for (const ticker_symbol of [symbol, ` ${symbol.toLowerCase()}\t`]) {
      expect((await validate(owner.client, { ticker_symbol, save: false })).json).toEqual({
        status: "success",
        body: { valid: true, security: securityJson(newer, { sector: "Tech" }) },
      });
    }
    expect(stack.upstream.polygon.about(symbol)).toEqual([]);
    expect(stack.upstream.yahoo.about(symbol)).toEqual([]);
  });

  test("looks a new ticker up at Polygon with today's close, and stores it unless told not to", async () => {
    const owner = await person("vt-polygon");
    const today = localDay(new Date());
    const symbol = ticker("POLY");
    stack.upstream.polygon.setTicker(symbol, { detail: { name: "Polygon Fund", currency_name: "usd" }, bars: [{ date: today, close: 123.45 }] });

    // Not saved: answered, nothing stored.
    const unsaved = await validate(owner.client, { ticker_symbol: symbol.toLowerCase(), save: false }, MINTS_AN_ID);
    expect(unsaved.json).toEqual({ status: "success", body: { valid: true, security: lookedUp(symbol, "Polygon Fund", "USD", 123.45) } });
    expect(await storedRows(stack, "securities", { ticker_symbol: symbol })).toEqual([]);
    expect(urlsOf(stack.upstream.polygon.about(symbol))).toEqual([detailUrl(symbol), aggsUrl(symbol, today)]);

    // Saved by default: the lookup is answered from what Polygon told the first one.
    const saved = await validate(owner.client, { ticker_symbol: symbol }, MINTS_AN_ID);
    expect(saved.json).toEqual({ status: "success", body: { valid: true, security: lookedUp(symbol, "Polygon Fund", "USD", 123.45) } });
    expect(saved.body.security!.security_id).not.toBe(unsaved.body.security!.security_id);
    expect(urlsOf(stack.upstream.polygon.about(symbol))).toEqual([detailUrl(symbol), aggsUrl(symbol, today)]);
    const security = saved.body.security!;
    expect(withoutStamps(await storedRow(stack, "securities", security.security_id as string))).toEqual(storedLookup(security));

    // From now on the stored row answers, as the API lists securities.
    const again = await validate(owner.client, { ticker_symbol: symbol }, MINTS_AN_ID);
    expect(again.json).toEqual({
      status: "success",
      body: { valid: true, security: securityJson({ ...security, close_price_as_of: today }, security as Record<string, unknown>) },
    });
  });

  test("stores the security for any `save` but false", async () => {
    const owner = await person("vt-save");
    for (const save of ["false", 0, null, "no", true]) {
      const symbol = ticker("SAVE");
      stack.upstream.polygon.setTicker(symbol, { detail: { name: "Saved", currency_name: "eur" } });
      const result = await validate(owner.client, { ticker_symbol: symbol, save }, MINTS_AN_ID);
      expect([save, result.json]).toEqual([save, { status: "success", body: { valid: true, security: lookedUp(symbol, "Saved", "EUR", null) } }]);
      expect([save, (await storedRows(stack, "securities", { ticker_symbol: symbol })).length]).toEqual([save, 1]);
    }
  });

  test("answers a security without a price when there is no close today, from Polygon or Yahoo", async () => {
    const owner = await person("vt-noprice");
    const symbol = ticker("NOBAR");
    stack.upstream.polygon.setTicker(symbol, { detail: { name: "No Bar Today" }, bars: [{ date: "2020-01-02", close: 1 }] });
    const result = await validate(owner.client, { ticker_symbol: symbol }, MINTS_AN_ID);
    expect(result.json).toEqual({ status: "success", body: { valid: true, security: lookedUp(symbol, "No Bar Today", "USD", null) } });
    const today = localDay(new Date());
    expect(urlsOf(stack.upstream.polygon.about(symbol))).toEqual([detailUrl(symbol), aggsUrl(symbol, today)]);
    // An empty price answer falls back to Yahoo for the price alone.
    expect(urlsOf(stack.upstream.yahoo.about(symbol))).toEqual([yahooPriceUrl(symbol, today)]);
    expect(withoutStamps(await storedRow(stack, "securities", result.body.security!.security_id as string))).toEqual(storedLookup(result.body.security!));
  });

  test("falls back to Yahoo for a ticker Polygon does not carry", async () => {
    const owner = await person("vt-yahoo");
    const today = localDay(new Date());
    const cases: [string, Parameters<typeof stack.upstream.yahoo.setTicker>[1], string, string, number | null][] = [
      [ticker("YFUND"), { longName: "Yahoo Fund", shortName: "YF", currency: "usd", bars: [{ date: today, close: 50.25 }] }, "Yahoo Fund", "USD", 50.25],
      [ticker("YSHORT"), { shortName: "Short Only", currency: "CHF" }, "Short Only", "CHF", null],
      [ticker("YNONE"), { bars: [{ date: today, close: null }] }, "", "USD", null],
    ];
    for (const [symbol, data, name, currency, close] of cases) {
      stack.upstream.yahoo.setTicker(symbol, data);
      const result = await validate(owner.client, { ticker_symbol: symbol }, MINTS_AN_ID);
      expect([symbol, result.json]).toEqual([symbol, { status: "success", body: { valid: true, security: lookedUp(symbol, name || symbol, currency, close) } }]);
      expect(urlsOf(stack.upstream.polygon.about(symbol))).toEqual([detailUrl(symbol), aggsUrl(symbol, today)]);
      expect(urlsOf(stack.upstream.yahoo.about(symbol))).toEqual([yahooDetailUrl(symbol), yahooPriceUrl(symbol, today)]);
      expect(withoutStamps(await storedRow(stack, "securities", result.body.security!.security_id as string))).toEqual(storedLookup(result.body.security!));
    }
  });

  test("calls a ticker no one knows invalid, and does not ask again", async () => {
    const owner = await person("vt-unknown");
    const symbol = ticker("NOPE");
    for (let i = 0; i < 2; i++) {
      expect((await validate(owner.client, { ticker_symbol: ` ${symbol.toLowerCase()} ` })).json).toEqual({
        status: "success",
        body: { valid: false, message: `Ticker "${symbol}" not found or invalid.` },
      });
    }
    const today = localDay(new Date());
    expect(urlsOf(stack.upstream.polygon.about(symbol))).toEqual([detailUrl(symbol), aggsUrl(symbol, today)]);
    expect(urlsOf(stack.upstream.yahoo.about(symbol))).toEqual([yahooDetailUrl(symbol), yahooPriceUrl(symbol, today)]);
    expect(await storedRows(stack, "securities", { ticker_symbol: symbol })).toEqual([]);
  });

  test("passes on a refusal instead of calling the ticker invalid", async () => {
    const owner = await person("vt-refused");
    const { polygon, yahoo } = stack.upstream;
    const cases: [string, (symbol: string) => void, string][] = [
      [ticker("PLAN"), (s) => polygon.respond({ ticker: s }, polygonAnswer.planLimit()), "Your plan doesn't include this data timeframe. Please upgrade your plan at https://polygon.io/pricing"],
      [ticker("PLANB"), (s) => polygon.respond({ ticker: s, endpoint: "detail" }, polygonAnswer.planLimit(null)), "Polygon plan does not include data for {s}"],
      [ticker("BUSY"), (s) => polygon.respond({ ticker: s }, polygonAnswer.rateLimited()), "You've exceeded the maximum requests per minute, please wait or upgrade your subscription to continue. https://polygon.io/pricing"],
      [ticker("ERR"), (s) => polygon.respond({ ticker: s, endpoint: "detail" }, polygonAnswer.error("Unknown API Key", 401)), "Unknown API Key"],
      [ticker("ERRB"), (s) => polygon.respond({ ticker: s, endpoint: "detail" }, polygonAnswer.error(null)), "Polygon refused the lookup for {s} (HTTP 200)"],
      [ticker("CUT"), (s) => polygon.respond({ ticker: s, endpoint: "detail" }, polygonAnswer.status(200, '{"results":', "application/json")), "Failed to fetch ticker details for {s}: JSON Parse error: Unexpected EOF"],
      [ticker("YBUSY"), (s) => yahoo.respond({ ticker: s }, yahooAnswer.rateLimited()), "Market data is busy right now; retry the lookup for {s} in a moment."],
      [ticker("YHTML"), (s) => yahoo.respond({ ticker: s }, yahooAnswer.status(200, "<html></html>")), "Bad response for {s}: JSON Parse error: Unrecognized token '<'"],
    ];
    for (const [symbol, script, message] of cases) {
      script(symbol);
      const result = await validate(owner.client, { ticker_symbol: symbol });
      expect([symbol, result.json]).toEqual([symbol, failed(message.replace("{s}", symbol))]);
    }
    expect(await storedRows(stack, "securities", { ticker_symbol: cases[0][0] })).toEqual([]);
  });

  test("answers the security it found even when it cannot be stored", async () => {
    const owner = await person("vt-unstorable");
    const [wide, coded] = [ticker("WIDE"), ticker("CODED")];
    stack.upstream.polygon.setTicker(wide, { detail: { name: "W".repeat(256), currency_name: "usd" } });
    stack.upstream.polygon.setTicker(coded, { detail: { name: "Coded", currency_name: "dollarsdollars" } });
    expect((await validate(owner.client, { ticker_symbol: wide }, MINTS_AN_ID)).json).toEqual({ status: "success", body: { valid: true, security: lookedUp(wide, "W".repeat(256), "USD", null) } });
    expect((await validate(owner.client, { ticker_symbol: coded }, MINTS_AN_ID)).json).toEqual({ status: "success", body: { valid: true, security: lookedUp(coded, "Coded", "DOLLARSDOLLARS", null) } });
    expect(await storedRows(stack, "securities", { ticker_symbol: wide })).toEqual([]);
    expect(await storedRows(stack, "securities", { ticker_symbol: coded })).toEqual([]);
  });

  test("fails as a server error when the detail has no currency, or Yahoo answers null", async () => {
    const owner = await person("vt-broken");
    const { polygon, yahoo, discord } = stack.upstream;
    const noCurrency = ticker("NOCUR");
    polygon.respond({ ticker: noCurrency, endpoint: "detail" }, polygonAnswer.json(200, { status: "OK", results: { ticker: noCurrency, name: "No Currency" } }));
    const result = await validate(owner.client, { ticker_symbol: noCurrency });
    expect(result.status).toBe(500);
    expect(result.json).toEqual(SERVER_ERROR);
    const title = "🚨 Budget Server Error: Route Error: POST /validate-ticker";
    await stack.waitFor(() => discord.alarms().some((alarm) => alarm.title === title), { what: "the route error alarm" });
    expect(discord.alarms().find((alarm) => alarm.title === title)?.description).toBe("**Error:** undefined is not an object (evaluating 'currency_name.toUpperCase')");

    // Yahoo's `null` throws for the detail and for the price alike; both are asked.
    const nulled = ticker("NULLED");
    yahoo.respond({ ticker: nulled }, yahooAnswer.json(200, null));
    const broken = await validate(owner.client, { ticker_symbol: nulled });
    expect(broken.status).toBe(500);
    expect(broken.json).toEqual(SERVER_ERROR);
    await stack.waitFor(() => yahoo.about(nulled).length === 2, { what: "both Yahoo requests" });
    const today = localDay(new Date());
    expect(urlsOf(polygon.about(nulled))).toEqual([detailUrl(nulled), aggsUrl(nulled, today)]);
    expect(urlsOf(yahoo.about(nulled))).toEqual([yahooDetailUrl(nulled), yahooPriceUrl(nulled, today)]);
  });

  test("spends one of the caller's ten lookups a minute on each ticker it has to look up", async () => {
    const owner = await person("vt-budget");
    const stored = ticker("KEPT");
    await seedSecurity(stack, `sec-${stored}`, { ticker_symbol: stored, name: "Kept" });
    const known = ticker("KNOWN");
    stack.upstream.polygon.setTicker(known, { detail: { name: "Known" } });
    // Asking again for a ticker that was not saved spends again, though the answer is remembered.
    for (let i = 0; i < 10; i++) {
      expect((await validate(owner.client, { ticker_symbol: known, save: false }, MINTS_AN_ID)).json.status).toBe("success");
    }
    expect(stack.upstream.polygon.about(known, "detail")).toHaveLength(1);
    expect((await validate(owner.client, { ticker_symbol: known, save: false })).json).toEqual(SHED);
    expect((await validate(owner.client, { ticker_symbol: ticker("FRESH") })).json).toEqual(SHED);
    // A stored ticker needs no lookup, and invalid input is refused first.
    expect((await validate(owner.client, { ticker_symbol: stored })).json).toEqual({
      status: "success",
      body: { valid: true, security: securityJson({ security_id: `sec-${stored}`, ticker_symbol: stored, name: "Kept" }) },
    });
    expect((await validate(owner.client, { ticker_symbol: "BAD TICKER" })).json).toEqual(failed(TICKER_MESSAGE));
    // The holding-snapshot lookup draws on the same budget.
    const account_id = await seedAccount(stack, owner.user_id, `vt-budget-acc-${counter}`);
    expect((await owner.client.post("/snapshots/holding", { account_id, ticker_symbol: ticker("HOLD"), quantity: 1 })).json).toEqual(SHED);
    // Someone else has their own.
    const other = await person("vt-budget-other");
    expect((await validate(other.client, { ticker_symbol: known, save: false }, MINTS_AN_ID)).json.status).toBe("success");
  });
});

describe("POST /validate-ticker with Polygon's rate gate on", () => {
  test("answers without a price when the price would wait, and refuses when the detail would", async () => {
    const gated = await startStack();
    stacks.push(gated);
    // A fresh benchmark price, so the refresh at the next start spends no slot of the gate.
    await seedSnapshot(gated, { snapshot_id: "benchmark-VOO-fresh", snapshot_type: "security", snapshot_date: new Date().toISOString(), security_id: "benchmark-VOO", close_price: 1 });
    await gated.restart({ POLYGON_RATE_LIMIT_PER_MIN: "1" });
    const owner = await person("vt-gated", gated);
    const [first, second] = [ticker("GATEA"), ticker("GATEB")];
    const today = localDay(new Date());
    for (const symbol of [first, second]) gated.upstream.polygon.setTicker(symbol, { detail: { name: symbol }, bars: [{ date: today, close: 9 }] });
    // The detail takes the minute's one slot; the price, which would wait a minute for the next, is skipped.
    expect((await validate(owner.client, { ticker_symbol: first }, MINTS_AN_ID)).json).toEqual({ status: "success", body: { valid: true, security: lookedUp(first, first, "USD", null) } });
    expect(urlsOf(gated.upstream.polygon.about(first))).toEqual([detailUrl(first)]);
    expect(gated.upstream.yahoo.about(first)).toEqual([]);
    const started = Date.now();
    expect((await validate(owner.client, { ticker_symbol: second })).json).toEqual(failed(`Market data is busy right now; retry the lookup for ${second} in a moment.`));
    expect(Date.now() - started).toBeLessThan(4_500);
    expect(gated.upstream.polygon.about(second)).toEqual([]);
  });
});

describe("POST /validate-ticker without a Polygon key", () => {
  test("says the market data is not configured, and asks no one", async () => {
    const keyless = await startStack({ env: { POLYGON_API_KEY: undefined } });
    stacks.push(keyless);
    const owner = await person("vt-keyless", keyless);
    const symbol = ticker("KEYLESS");
    keyless.upstream.yahoo.setTicker(symbol, { longName: "Only Yahoo" });
    expect((await validate(owner.client, { ticker_symbol: symbol })).json).toEqual(failed("Market data API is not configured. Contact your administrator."));
    expect(keyless.upstream.polygon.about(symbol)).toEqual([]);
    expect(keyless.upstream.yahoo.about(symbol)).toEqual([]);
  });
});
