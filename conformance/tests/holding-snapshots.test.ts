/**
 * Holding snapshots: `GET /snapshots/holding`, `POST /snapshots/holding`
 * (create, with the ticker lookup through Polygon and Yahoo and the monthly
 * price backfill it starts, and update) and `DELETE /snapshots/holding`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUserClient, startStack, urlsOf, type ApiClient, type RequestOptions, type Stack } from "../harness";
import { polygonAnswer } from "../harness/upstreams/polygon";
import { yahooAnswer } from "../harness/upstreams/yahoo";
import { seedApiKey } from "../harness/seed/budgets";
import {
  localDay,
  localMidnight,
  seedAccount,
  seedSecurity,
  seedSnapshot,
  shareData,
  softDelete,
  squashedDay,
  storedRow,
  storedRows,
  storedSecuritySnapshots,
  withWritesBroken,
  withoutStamps,
  type StoredRow,
} from "../harness/seed/snapshots";

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
const SUCCESS = { status: "success" };
const SERVER_ERROR = { status: "error", message: "Internal server error" };
const failed = (message: string) => ({ status: "failed", message });
const NOT_FOUND = failed("Snapshot not found or access denied.");
const NO_ACCOUNT = failed("Account not found or access denied.");
const SHED = failed("Too many ticker lookups, try again in a minute.");
const TICKER_MESSAGE = "Ticker symbol must be 1-16 characters of A-Z, 0-9, '.', '-' or ':'";

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
  account_id: string;
}

let counter = 0;
/** A user of their own with an investment account, signed in. */
const person = async (name: string, on = stack): Promise<Person> => {
  const { client, user } = await createUserClient(on, `${name}-${++counter}`);
  const account_id = await seedAccount(on, user.user_id, `${name}-acc-${counter}`);
  return { client, user_id: user.user_id, account_id };
};

/** A ticker no other test uses: the market-data clients keep what they learn for an hour. */
let tickers = 0;
const ticker = (stem: string) => `${stem}${++tickers}`;

const pad = (n: number) => String(n).padStart(2, "0");
const yearMonth = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
const nextYearMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
};
const yesterday = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
};

/**
 * The months the backfill a snapshot dated `from` starts walks, as the
 * day each is priced for: the 15th, or yesterday for the current month.
 * Each is a `YYYY-MM-DD` read as UTC midnight, so `asked` (the local day of
 * that instant) is the day the price is asked for and `squashed` the day its
 * snapshot is filed under.
 */
const backfillMonths = (from: Date) => {
  const now = yearMonth(new Date());
  const months: { month: string; day: string; asked: string; squashed: string; date: string }[] = [];
  for (let cursor = yearMonth(from), touched = 0; cursor <= now && touched < 60; cursor = nextYearMonth(cursor), touched++) {
    const day = cursor === now ? localDay(yesterday()) : `${cursor}-15`;
    const instant = new Date(day);
    months.push({ month: cursor, day, asked: localDay(instant), squashed: squashedDay(instant), date: instant.toISOString() });
  }
  return months;
};

/** Waits until a ticker has had `aggs` price requests at Polygon and `yahoo` chart requests at Yahoo. */
const settle = async (symbol: string, { aggs = 0, yahoo = 0 }: { aggs?: number; yahoo?: number }, on = stack) => {
  await on.waitFor(
    () => on.upstream.polygon.about(symbol, "aggs").length >= aggs && on.upstream.yahoo.about(symbol).length >= yahoo,
    { what: `${aggs} price requests and ${yahoo} Yahoo requests for ${symbol}` },
  );
  // Nothing more follows: the backfill asks for each month once.
  expect(on.upstream.polygon.about(symbol, "aggs")).toHaveLength(aggs);
};

/** A security that is cash: the backfill skips it without a request. */
const cashSecurity = async (on = stack) => {
  const symbol = ticker("CASH");
  const security_id = await seedSecurity(on, `sec-${symbol}`, { ticker_symbol: symbol, name: `Cash ${symbol}`, type: "cash" });
  return { symbol, security_id };
};

const storedSnapshot = async (snapshot_id: string, on = stack) => withoutStamps(await storedRow(on, "snapshots", snapshot_id));
const storedHolding = async (holding_id: string, on = stack) => withoutStamps(await storedRow(on, "holdings", holding_id));

/** The stored row of a holding snapshot; `snapshot_date` is the UTC day written. */
const holdingSnapshotRow = (fields: {
  snapshot_id: string;
  user_id: string;
  day: string;
  account_id: string;
  security_id: string;
  quantity?: number | null;
  cost_basis?: number | null;
  institution_price?: number | null;
  institution_value?: number | null;
  is_deleted?: boolean;
}): StoredRow => ({
  snapshot_id: fields.snapshot_id,
  user_id: fields.user_id,
  snapshot_date: `${fields.day}T00:00:00+00:00`,
  snapshot_type: "holding",
  account_id: null,
  balances_available: null,
  balances_current: null,
  balances_limit: null,
  balances_iso_currency_code: null,
  security_id: null,
  close_price: null,
  holding_account_id: fields.account_id,
  holding_security_id: fields.security_id,
  institution_price: fields.institution_price ?? null,
  institution_value: fields.institution_value ?? null,
  cost_basis: fields.cost_basis ?? null,
  quantity: fields.quantity ?? null,
  is_deleted: fields.is_deleted ?? false,
});

/** The stored holdings row a snapshot leaves, `raw` being the holding as written. */
const holdingRow = (fields: {
  user_id: string;
  account_id: string;
  security_id: string;
  quantity: number;
  cost_basis: number | null;
  institution_price: number;
  institution_value: number;
  as_of: string;
  stored?: Partial<Record<"institution_value" | "institution_price", number>>;
}): StoredRow => {
  const holding_id = `${fields.account_id}-${fields.security_id}`;
  return {
    holding_id,
    user_id: fields.user_id,
    account_id: fields.account_id,
    security_id: fields.security_id,
    institution_price: fields.stored?.institution_price ?? fields.institution_price,
    institution_price_as_of: fields.as_of.slice(0, 10),
    institution_value: fields.stored?.institution_value ?? fields.institution_value,
    cost_basis: fields.cost_basis,
    quantity: fields.quantity,
    iso_currency_code: null,
    raw: {
      holding_id,
      account_id: fields.account_id,
      security_id: fields.security_id,
      quantity: fields.quantity,
      cost_basis: fields.cost_basis,
      institution_price: fields.institution_price,
      institution_price_as_of: fields.as_of,
      institution_value: fields.institution_value,
      iso_currency_code: null,
      unofficial_currency_code: null,
    },
    is_deleted: false,
  };
};

/** The security row a lookup stores: what the detail gave, nothing else. */
const lookedUpSecurity = (security_id: string, symbol: string, name: string | undefined, currency: string) => {
  const raw: Record<string, unknown> = { security_id, ticker_symbol: symbol, name, iso_currency_code: currency };
  if (name === undefined) delete raw.name;
  for (const key of ["close_price", "close_price_as_of", "isin", "cusip", "sedol", "institution_security_id", "institution_id", "proxy_security_id", "is_cash_equivalent", "type", "update_datetime", "unofficial_currency_code", "market_identifier_code", "sector", "industry", "option_contract", "fixed_income"]) {
    raw[key] = null;
  }
  return {
    security_id,
    name: name ?? null,
    ticker_symbol: symbol,
    type: null,
    close_price: null,
    close_price_as_of: null,
    iso_currency_code: currency,
    isin: null,
    cusip: null,
    raw,
  };
};

const post = <T = { snapshot_id: string; security_id: string }>(client: ApiClient, body: unknown, options: RequestOptions = {}) =>
  client.post<T>("/snapshots/holding", body, options);

/**
 * A security the server mints from a lookup gets a random five-digit id, so
 * an answer that carries one is left out of the cross-server comparison; the
 * test still asserts its shape and everything stored under it.
 */
const MINTS_AN_ID: RequestOptions = { noCompare: true };

describe("a caller without a session", () => {
  test("is refused on every route, and nothing is changed", async () => {
    const owner = await person("anon");
    const { security_id } = await cashSecurity();
    const snapshot_id = await seedSnapshot(stack, { snapshot_id: `holding-anon-${counter}`, user_id: owner.user_id, snapshot_type: "holding", snapshot_date: "2026-01-01T00:00:00Z", holding_account_id: owner.account_id, holding_security_id: security_id, quantity: 1 });
    const before = await storedRows(stack, "snapshots");
    const anonymous = stack.anonymous();
    // An API key does not do either: these routes take a session only.
    const key = await seedApiKey(stack, owner.user_id, ["transactions:suggest", "budgets:read", "budgets:write"]);
    for (const [method, path, body] of [
      ["GET", "/snapshots/holding"],
      ["POST", "/snapshots/holding", { account_id: owner.account_id, security_id, quantity: 1 }],
      ["POST", "/snapshots/holding", { snapshot_id, quantity: 2 }],
      ["DELETE", `/snapshots/holding?id=${snapshot_id}`],
    ] as const) {
      for (const headers of [{}, { Authorization: `Bearer ${key}`, "X-Real-IP": "10.42.0.1" }] as Record<string, string>[]) {
        const result = await anonymous.request(method, path, { body, headers });
        expect([method, path, result.status]).toEqual([method, path, 401]);
        expect(result.json).toEqual(failed("Not authenticated."));
      }
    }
    expect(await storedRows(stack, "snapshots")).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// GET /snapshots/holding
// ---------------------------------------------------------------------------

describe("GET /snapshots/holding", () => {
  test("lists the live holding snapshots of the caller and the sharing group, by date, with each security's ticker and name", async () => {
    const [owner, member, stranger] = [await person("hlist"), await person("hlist-member"), await person("hlist-stranger")];
    await shareData(stack, owner.user_id, member.user_id);
    const n = counter;
    const named = await seedSecurity(stack, `hl-named-${n}`, { ticker_symbol: `HLN${n}`, name: "Named Fund" });
    const unnamed = await seedSecurity(stack, `hl-unnamed-${n}`, { ticker_symbol: null, name: null });
    const rows = [
      { snapshot_id: `hl-${n}-a`, user_id: owner.user_id, snapshot_date: "2026-01-03T00:00:00Z", holding_account_id: owner.account_id, holding_security_id: named, quantity: 10.5, cost_basis: 900, institution_price: 101.123456, institution_value: 1061.8 },
      { snapshot_id: `hl-${n}-b`, user_id: owner.user_id, snapshot_date: "2026-01-01T12:30:00Z", holding_account_id: owner.account_id, holding_security_id: unnamed, quantity: 0, cost_basis: null, institution_price: null, institution_value: null },
      // A security with no row: no ticker and no name.
      { snapshot_id: `hl-${n}-c`, user_id: owner.user_id, snapshot_date: "2026-01-02T00:00:00Z", holding_account_id: `other-${n}`, holding_security_id: `gone-${n}`, quantity: null, cost_basis: -5.5 },
      { snapshot_id: `hl-${n}-d`, user_id: member.user_id, snapshot_date: "2026-01-04T00:00:00Z", holding_account_id: member.account_id, holding_security_id: named, quantity: 2 },
    ];
    for (const row of rows) await seedSnapshot(stack, { snapshot_type: "holding", ...row });
    // Left out: deleted, a stranger's, and other snapshot types.
    await seedSnapshot(stack, { snapshot_id: `hl-${n}-deleted`, user_id: owner.user_id, snapshot_type: "holding", snapshot_date: "2026-01-05T00:00:00Z", holding_account_id: owner.account_id, holding_security_id: named, quantity: 1, is_deleted: true });
    await seedSnapshot(stack, { snapshot_id: `hl-${n}-stranger`, user_id: stranger.user_id, snapshot_type: "holding", snapshot_date: "2026-01-05T00:00:00Z", holding_account_id: stranger.account_id, holding_security_id: named, quantity: 1 });
    await seedSnapshot(stack, { snapshot_id: `hl-${n}-balance`, user_id: owner.user_id, snapshot_type: "account_balance", snapshot_date: "2026-01-05T00:00:00Z", account_id: owner.account_id, balances_current: 1 });
    await seedSnapshot(stack, { snapshot_id: `hl-${n}-price`, snapshot_type: "security", snapshot_date: "2026-01-05T00:00:00Z", security_id: named, close_price: 1 });

    const listed = {
      a: { snapshot_id: `hl-${n}-a`, snapshot_date: "2026-01-03T00:00:00.000Z", holding_account_id: owner.account_id, holding_security_id: named, institution_price: 101.123456, institution_value: 1061.8, cost_basis: 900, quantity: 10.5, ticker_symbol: `HLN${n}`, security_name: "Named Fund" },
      b: { snapshot_id: `hl-${n}-b`, snapshot_date: "2026-01-01T12:30:00.000Z", holding_account_id: owner.account_id, holding_security_id: unnamed, quantity: 0, ticker_symbol: null, security_name: null },
      c: { snapshot_id: `hl-${n}-c`, snapshot_date: "2026-01-02T00:00:00.000Z", holding_account_id: `other-${n}`, holding_security_id: `gone-${n}`, cost_basis: -5.5, ticker_symbol: null, security_name: null },
      d: { snapshot_id: `hl-${n}-d`, snapshot_date: "2026-01-04T00:00:00.000Z", holding_account_id: member.account_id, holding_security_id: named, quantity: 2, ticker_symbol: `HLN${n}`, security_name: "Named Fund" },
    };
    const all = { status: "success", body: { snapshots: [listed.b, listed.c, listed.a, listed.d] } };
    expect((await owner.client.get("/snapshots/holding")).json).toEqual(all);
    expect((await member.client.get("/snapshots/holding")).json).toEqual(all);

    // One account; a parameter that is empty, blank or repeated narrows nothing.
    expect((await owner.client.get("/snapshots/holding", { query: { account_id: owner.account_id } })).body).toEqual({ snapshots: [listed.b, listed.a] });
    expect((await owner.client.get("/snapshots/holding", { query: { account_id: member.account_id } })).body).toEqual({ snapshots: [listed.d] });
    expect((await owner.client.get("/snapshots/holding", { query: { account_id: stranger.account_id } })).body).toEqual({ snapshots: [] });
    for (const query of ["?account_id=", "?account_id=%20", `?account_id=${owner.account_id}&account_id=${member.account_id}`, `?ACCOUNT_ID=${owner.account_id}`]) {
      expect([query, (await owner.client.get(`/snapshots/holding${query}`)).json]).toEqual([query, all]);
    }
    expect((await stranger.client.get("/snapshots/holding")).body).toEqual({
      snapshots: [{ snapshot_id: `hl-${n}-stranger`, snapshot_date: "2026-01-05T00:00:00.000Z", holding_account_id: stranger.account_id, holding_security_id: named, quantity: 1, ticker_symbol: `HLN${n}`, security_name: "Named Fund" }],
    });
    expect((await (await person("hlist-empty")).client.get("/snapshots/holding")).json).toEqual({ status: "success", body: { snapshots: [] } });
  });
});

// ---------------------------------------------------------------------------
// POST /snapshots/holding: create
// ---------------------------------------------------------------------------

describe("POST /snapshots/holding creates", () => {
  test("refuses a body that is not an object", async () => {
    const owner = await person("hbody");
    for (const [body, message] of [
      [null, "Request body is required"],
      [[], "Request body must be an object"],
      ["text", "Request body must be an object"],
      [7, "Request body must be an object"],
    ] as const) {
      expect([body, (await post(owner.client, body)).json]).toEqual([body, failed(message)]);
    }
    expect((await owner.client.request("POST", "/snapshots/holding")).json).toEqual(failed("Request body is required"));
  });

  test("checks the account, the security, the ticker and every amount, in that order, before anything is looked up", async () => {
    const owner = await person("hvalid");
    const base = { account_id: "no-such-account", ticker_symbol: "VALID", quantity: 1 };
    const cases: [unknown, string][] = [
      // A falsy snapshot id means create.
      ...[undefined, null, "", 0, false].map((snapshot_id): [unknown, string] => [{ snapshot_id, quantity: 1 }, "account_id is required"]),
      ...[null, "", 0, false].map((account_id): [unknown, string] => [{ ...base, account_id }, "account_id is required"]),
      [{ ticker_symbol: "VALID", quantity: 1 }, "account_id is required"],
      ...[5, true, [], ["acc"], {}].map((account_id): [unknown, string] => [{ ...base, account_id }, "account_id must be a string"]),
      [{ ...base, account_id: 5, security_id: 5, quantity: "x" }, "account_id must be a string"],
      ...[null, 5, true, [], {}].map((security_id): [unknown, string] => [{ ...base, security_id }, "security_id must be a string"]),
      [{ ...base, security_id: null, ticker_symbol: "", quantity: "x" }, "security_id must be a string"],
      // Without a security id, the ticker names the security.
      [{ account_id: "no-such-account", quantity: 1 }, "Missing required field: ticker_symbol"],
      [{ ...base, ticker_symbol: null }, "Missing required field: ticker_symbol"],
      [{ ...base, security_id: "", ticker_symbol: undefined }, "Missing required field: ticker_symbol"],
      ...[5, true, ["VOO"], {}].map((ticker_symbol): [unknown, string] => [{ ...base, ticker_symbol }, "Field ticker_symbol must be a string"]),
      ...["", "   ", "VO O", "VO\tO", "VOO$", "ÅÄÖ", "ABCDEFGHIJKLMNOPQ"].map((ticker_symbol): [unknown, string] => [{ ...base, ticker_symbol }, TICKER_MESSAGE]),
      [{ ...base, ticker_symbol: "", quantity: "x" }, TICKER_MESSAGE],
      // Then the amounts: quantity is required.
      [{ account_id: "no-such-account", ticker_symbol: "VALID" }, "Missing required field: quantity"],
      [{ ...base, quantity: null }, "Field quantity must be a number"],
      ...["1", "", true, [], {}].map((quantity): [unknown, string] => [{ ...base, quantity }, "Field quantity must be a number"]),
      [{ ...base, quantity: 1e9 }, "Field quantity must be at most 999999999.999999"],
      [{ ...base, quantity: -1e9 }, "Field quantity must be at most 999999999.999999"],
      [{ ...base, quantity: 1000000000 }, "Field quantity must be at most 999999999.999999"],
      ...["1", true, []].map((cost_basis): [unknown, string] => [{ ...base, cost_basis }, "Field cost_basis must be a number"]),
      [{ ...base, cost_basis: 1e13 }, "Field cost_basis must be at most 9999999999999.99"],
      [{ ...base, cost_basis: -1e13 }, "Field cost_basis must be at most 9999999999999.99"],
      ...["1", false, {}].map((institution_price): [unknown, string] => [{ ...base, institution_price }, "Field institution_price must be a number"]),
      [{ ...base, institution_price: 1e9 }, "Field institution_price must be at most 999999999.999999"],
      ...["1", true, [1]].map((institution_value): [unknown, string] => [{ ...base, institution_value }, "Field institution_value must be a number"]),
      [{ ...base, institution_value: 1e13 }, "Field institution_value must be at most 9999999999999.99"],
      [{ ...base, institution_value: -10000000000000 }, "Field institution_value must be at most 9999999999999.99"],
      [{ ...base, quantity: "x", cost_basis: "x", institution_price: "x", institution_value: "x" }, "Field quantity must be a number"],
      [{ ...base, cost_basis: "x", institution_price: "x", institution_value: "x" }, "Field cost_basis must be a number"],
      [{ ...base, institution_price: "x", institution_value: "x" }, "Field institution_price must be a number"],
      // The value the holdings row would derive from quantity times price must fit its column.
      [{ ...base, quantity: 1e8, institution_price: 1e8 }, "Field institution_value must be at most 9999999999999.99"],
      [{ ...base, quantity: -1e8, institution_price: 1e8, institution_value: null }, "Field institution_value must be at most 9999999999999.99"],
      [{ ...base, quantity: 1e8, institution_price: 1e5 + 0.01 }, "Field institution_value must be at most 9999999999999.99"],
      [{ ...base, quantity: 1e8, institution_price: 1e8, snapshot_date: 5 }, "Field institution_value must be at most 9999999999999.99"],
      // Then the date.
      ...[5, true, [], {}].map((snapshot_date): [unknown, string] => [{ ...base, snapshot_date }, "snapshot_date must be a string"]),
      ...["yesterday", " ", "2026-13-01", "2026-03-15Tnoon"].map((snapshot_date): [unknown, string] => [{ ...base, snapshot_date }, "snapshot_date is not a valid date"]),
    ];
    for (const [body, message] of cases) {
      const result = await post(owner.client, body);
      expect([body, result.status, result.json]).toEqual([body, 200, failed(message)]);
    }
    // Values at their bounds pass to the account lookup.
    for (const body of [
      { ...base, quantity: 999999999.999999, institution_value: 1 },
      { ...base, quantity: -999999999.999999, institution_value: 1 },
      { ...base, quantity: 0, cost_basis: 9999999999999.99, institution_price: 999999999.999999, institution_value: -9999999999999.99 },
      { ...base, quantity: 1e8, institution_price: 1e8, institution_value: 0 },
      { ...base, quantity: 1e8, institution_price: 99999.99 },
      { ...base, ticker_symbol: "voo\n", quantity: 1 },
      { ...base, quantity: 1e8, institution_price: null, cost_basis: null },
      { ...base, quantity: 1, snapshot_date: null },
      { ...base, quantity: 1, snapshot_date: "" },
      { ...base, ticker_symbol: " voo ", quantity: 1 },
      { ...base, ticker_symbol: "BRK.B", quantity: 1 },
      { ...base, ticker_symbol: "X:BTCUSD", quantity: 1 },
      { ...base, ticker_symbol: "ABCDEFGHIJKLMNOP", quantity: 1 },
      { ...base, security_id: "no-such-security", ticker_symbol: 5, quantity: 1 },
    ]) {
      expect([body, (await post(owner.client, body)).json]).toEqual([body, NO_ACCOUNT]);
    }
    // Nothing was asked of the market data.
    expect(stack.upstream.polygon.about("VALID")).toEqual([]);
  });

  test("writes the snapshot and the holding for a stored security named by ticker, and answers their ids", async () => {
    const owner = await person("hcreate");
    const { symbol, security_id } = await cashSecurity();
    const result = await post(owner.client, { account_id: owner.account_id, ticker_symbol: ` ${symbol.toLowerCase()} `, quantity: 10.5, cost_basis: 900, institution_price: 100.25 });
    const today = new Date();
    const snapshot_id = `holding-${owner.account_id}-${security_id}-${squashedDay(today)}`;
    expect(result.json).toEqual({ status: "success", body: { snapshot_id, security_id } });
    // The day stored is the UTC day of the moment of the post.
    const snapshot = await storedSnapshot(snapshot_id);
    expect(snapshot).toEqual(holdingSnapshotRow({ snapshot_id, user_id: owner.user_id, day: today.toISOString().slice(0, 10), account_id: owner.account_id, security_id, quantity: 10.5, cost_basis: 900, institution_price: 100.25 }));
    const holding = await storedHolding(`${owner.account_id}-${security_id}`);
    const as_of = (holding!.raw as { institution_price_as_of: string }).institution_price_as_of;
    expect(as_of).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(Date.parse(as_of) - Date.now())).toBeLessThan(60_000);
    expect(holding).toEqual(
      holdingRow({ user_id: owner.user_id, account_id: owner.account_id, security_id, quantity: 10.5, cost_basis: 900, institution_price: 100.25, institution_value: 1052.625, as_of, stored: { institution_value: 1052.63 } }),
    );
    // It lists back.
    expect((await owner.client.get("/snapshots/holding")).body).toEqual({
      snapshots: [{ snapshot_id, snapshot_date: new Date(snapshot!.snapshot_date as string).toISOString(), holding_account_id: owner.account_id, holding_security_id: security_id, institution_price: 100.25, cost_basis: 900, quantity: 10.5, ticker_symbol: symbol, security_name: `Cash ${symbol}` }],
    });
    // A stored security is used as it is: no lookup, and no request.
    expect(stack.upstream.polygon.about(symbol)).toEqual([]);
  });

  test("files the snapshot under the local day of its date, and stores the UTC day of that midnight", async () => {
    const owner = await person("hdated");
    const { security_id } = await cashSecurity();
    for (const [snapshot_date, date] of [
      ["2026-03-15", localMidnight("2026-03-15")],
      ["2025-12-31T23:30:00Z", new Date("2025-12-31T23:30:00Z")],
      ["2026-01-01T00:30:00", new Date("2026-01-01T00:30:00")],
      ["2024-02-29", localMidnight("2024-02-29")],
    ] as const) {
      const result = await post(owner.client, { account_id: owner.account_id, security_id, quantity: 1, institution_price: 2, snapshot_date });
      const snapshot_id = `holding-${owner.account_id}-${security_id}-${squashedDay(date)}`;
      expect([snapshot_date, result.json]).toEqual([snapshot_date, { status: "success", body: { snapshot_id, security_id } }]);
      const day = date.toISOString().slice(0, 10);
      expect(await storedSnapshot(snapshot_id)).toEqual(holdingSnapshotRow({ snapshot_id, user_id: owner.user_id, day, account_id: owner.account_id, security_id, quantity: 1, institution_price: 2 }));
      // The holding takes the latest post's date.
      expect(await storedHolding(`${owner.account_id}-${security_id}`)).toEqual(
        holdingRow({ user_id: owner.user_id, account_id: owner.account_id, security_id, quantity: 1, cost_basis: null, institution_price: 2, institution_value: 2, as_of: date.toISOString() }),
      );
    }
  });

  test("updates the same account, security and day in place, a deleted one included, and leaves out the amounts not given", async () => {
    const owner = await person("hsame");
    const { security_id } = await cashSecurity();
    const snapshot_id = `holding-${owner.account_id}-${security_id}-20260310`;
    const day = localMidnight("2026-03-10").toISOString().slice(0, 10);
    const write = (body: Record<string, unknown>) => post(owner.client, { account_id: owner.account_id, security_id, snapshot_date: "2026-03-10", ...body });
    expect((await write({ quantity: 5, cost_basis: 50, institution_price: 11, institution_value: 54 })).json).toEqual({ status: "success", body: { snapshot_id, security_id } });
    expect(await storedSnapshot(snapshot_id)).toEqual(holdingSnapshotRow({ snapshot_id, user_id: owner.user_id, day, account_id: owner.account_id, security_id, quantity: 5, cost_basis: 50, institution_price: 11, institution_value: 54 }));
    await softDelete(stack, "snapshots", snapshot_id);
    // Only quantity: the snapshot keeps its other amounts, the holding takes the defaults.
    await write({ quantity: 6 });
    expect(await storedSnapshot(snapshot_id)).toEqual(holdingSnapshotRow({ snapshot_id, user_id: owner.user_id, day, account_id: owner.account_id, security_id, quantity: 6, cost_basis: 50, institution_price: 11, institution_value: 54 }));
    expect(await storedHolding(`${owner.account_id}-${security_id}`)).toEqual(
      holdingRow({ user_id: owner.user_id, account_id: owner.account_id, security_id, quantity: 6, cost_basis: null, institution_price: 0, institution_value: 0, as_of: localMidnight("2026-03-10").toISOString() }),
    );
    // Explicit nulls clear.
    await write({ quantity: 0, cost_basis: null, institution_price: null, institution_value: null });
    expect(await storedSnapshot(snapshot_id)).toEqual(holdingSnapshotRow({ snapshot_id, user_id: owner.user_id, day, account_id: owner.account_id, security_id, quantity: 0 }));
    expect(await storedRows(stack, "snapshots", { holding_account_id: owner.account_id })).toHaveLength(1);
  });

  test("answers success when the snapshot or the holding cannot be written, and writes the other", async () => {
    const owner = await person("hswallow");
    const { security_id } = await cashSecurity();
    const holding_id = `${owner.account_id}-${security_id}`;
    const body = { account_id: owner.account_id, security_id, quantity: 1, snapshot_date: "2026-02-04" };
    const snapshot_id = `holding-${owner.account_id}-${security_id}-20260204`;
    await withWritesBroken(stack, "holdings", { event: "INSERT", mode: "raise" }, async () => {
      expect((await post(owner.client, body)).json).toEqual({ status: "success", body: { snapshot_id, security_id } });
    });
    expect(await storedHolding(holding_id)).toBeUndefined();
    expect(await storedSnapshot(snapshot_id)).toMatchObject({ quantity: 1 });
    await withWritesBroken(stack, "snapshots", { event: "INSERT", mode: "raise" }, async () => {
      expect((await post(owner.client, { ...body, quantity: 2 })).json).toEqual({ status: "success", body: { snapshot_id, security_id } });
    });
    expect(await storedSnapshot(snapshot_id)).toMatchObject({ quantity: 1 });
    expect(await storedHolding(holding_id)).toMatchObject({ quantity: 2 });
  });

  test("names a security by id even when another shares its ticker, and refuses an id with no security", async () => {
    const owner = await person("hbyid");
    const symbol = ticker("TWIN");
    const first = await seedSecurity(stack, `sec-${symbol}-a`, { ticker_symbol: symbol, type: "cash" });
    await seedSecurity(stack, `sec-${symbol}-b`, { ticker_symbol: symbol, type: "cash" });
    const result = await post(owner.client, { account_id: owner.account_id, security_id: first, ticker_symbol: "IGNORED!", quantity: 3, snapshot_date: "2026-02-02" });
    expect(result.json).toEqual({ status: "success", body: { snapshot_id: `holding-${owner.account_id}-${first}-20260202`, security_id: first } });
    expect((await post(owner.client, { account_id: owner.account_id, security_id: "no-such-security", quantity: 3 })).json).toEqual(failed("Security not found."));
    // The account is looked up before the security.
    expect((await post(owner.client, { account_id: "no-such-account", security_id: "no-such-security", quantity: 3 })).json).toEqual(NO_ACCOUNT);
    expect(await storedRows(stack, "snapshots", { holding_security_id: "no-such-security" })).toEqual([]);
  });

  test("writes under a member's account as the member's, and refuses an account that is missing, deleted or a stranger's", async () => {
    const [owner, member, stranger] = [await person("hgroup"), await person("hgroup-member"), await person("hgroup-stranger")];
    await shareData(stack, owner.user_id, member.user_id);
    const deleted = await seedAccount(stack, owner.user_id, `hgroup-deleted-${counter}`);
    await softDelete(stack, "accounts", deleted);
    const { security_id } = await cashSecurity();
    const result = await post(owner.client, { account_id: member.account_id, security_id, quantity: 2, institution_price: 3, snapshot_date: "2026-02-03" });
    const snapshot_id = `holding-${member.account_id}-${security_id}-20260203`;
    expect(result.json).toEqual({ status: "success", body: { snapshot_id, security_id } });
    expect(await storedSnapshot(snapshot_id)).toMatchObject({ user_id: member.user_id, holding_account_id: member.account_id });
    expect(await storedHolding(`${member.account_id}-${security_id}`)).toMatchObject({ user_id: member.user_id, quantity: 2, institution_value: 6 });
    for (const account_id of [stranger.account_id, deleted, "no-such-account"]) {
      expect([account_id, (await post(owner.client, { account_id, security_id: "no-such-security", quantity: 1, snapshot_date: "2026-02-03" })).json]).toEqual([account_id, NO_ACCOUNT]);
    }
    expect(await storedRows(stack, "holdings", { account_id: stranger.account_id })).toEqual([]);
  });

  describe("a ticker not stored yet", () => {
    test("is looked up at Polygon, stored, and priced back to the snapshot's month", async () => {
      const owner = await person("hpolygon");
      const symbol = ticker("POLY");
      const from = localMidnight(`${yearMonth(new Date(new Date().getFullYear(), new Date().getMonth() - 3, 1))}-20`);
      const months = backfillMonths(from);
      // Polygon prices every month but the second; Yahoo has that one.
      stack.upstream.polygon.setTicker(symbol, {
        detail: { name: "Polygon Listed Fund", currency_name: "usd" },
        bars: months.filter((_, i) => i !== 1).map((m, i) => ({ date: m.asked, close: 100 + i })),
      });
      stack.upstream.yahoo.setTicker(symbol, { bars: [{ date: months[1].asked, close: 55.5 }] });
      const result = await post(owner.client, { account_id: owner.account_id, ticker_symbol: symbol.toLowerCase(), quantity: 4, institution_value: 400, snapshot_date: localDay(from) }, MINTS_AN_ID);
      expect(result.json.status).toBe("success");
      const { security_id } = result.body;
      expect(security_id).toMatch(/^[0-9a-f]{5}$/);
      expect(result.body.snapshot_id).toBe(`holding-${owner.account_id}-${security_id}-${squashedDay(from)}`);
      expect(withoutStamps(await storedRow(stack, "securities", security_id))).toEqual(lookedUpSecurity(security_id, symbol, "Polygon Listed Fund", "USD"));

      await settle(symbol, { aggs: months.length, yahoo: 1 });
      expect(urlsOf(stack.upstream.polygon.about(symbol))).toEqual([detailUrl(symbol), ...months.map((m) => aggsUrl(symbol, m.asked))]);
      expect(urlsOf(stack.upstream.yahoo.about(symbol))).toEqual([yahooPriceUrl(symbol, months[1].asked)]);
      const expected = months.map((m, i) => ({
        snapshot_id: `${security_id}-${m.squashed}`,
        snapshot_date: m.date.slice(0, 19),
        close_price: i === 1 ? 55.5 : 100 + (i > 1 ? i - 1 : i),
      }));
      await stack.waitFor(async () => (await storedSecuritySnapshots(stack, security_id)).length === months.length, { what: "the backfilled prices" });
      expect(await storedSecuritySnapshots(stack, security_id)).toEqual(expected);
      // The backfill writes only the snapshots; the security row is untouched.
      expect(withoutStamps(await storedRow(stack, "securities", security_id))).toEqual(lookedUpSecurity(security_id, symbol, "Polygon Listed Fund", "USD"));
      const priced = (await storedRows(stack, "snapshots", { security_id }))[0];
      expect(priced).toMatchObject({ user_id: null, snapshot_type: "security", is_deleted: false });

      // The next post finds the security stored: no lookup, and the backfill skips every month it has.
      const again = await post(owner.client, { account_id: owner.account_id, ticker_symbol: symbol, quantity: 5, snapshot_date: localDay(from) }, MINTS_AN_ID);
      expect(again.json).toEqual({ status: "success", body: { snapshot_id: result.body.snapshot_id, security_id } });
      expect(stack.upstream.polygon.about(symbol, "detail")).toHaveLength(1);
    });

    test("falls back to Yahoo when Polygon has no such ticker, and to its short name and currency", async () => {
      const owner = await person("hyahoo");
      const [longName, shortName, bare] = [ticker("YLONG"), ticker("YSHORT"), ticker("YBARE")];
      stack.upstream.yahoo.setTicker(longName, { longName: "Yahoo Long Name", shortName: "Short", currency: "eur" });
      stack.upstream.yahoo.setTicker(shortName, { shortName: "Only Short", currency: "GBp" });
      stack.upstream.yahoo.setTicker(bare, {});
      const today = localDay(new Date());
      for (const [symbol, name, currency] of [
        [longName, "Yahoo Long Name", "EUR"],
        [shortName, "Only Short", "GBP"],
        [bare, bare, "USD"],
      ] as const) {
        const result = await post(owner.client, { account_id: owner.account_id, ticker_symbol: symbol, quantity: 1, snapshot_date: today }, MINTS_AN_ID);
        expect([symbol, result.json.status]).toEqual([symbol, "success"]);
        const { security_id } = result.body;
        expect(withoutStamps(await storedRow(stack, "securities", security_id))).toEqual(lookedUpSecurity(security_id, symbol, name, currency));
        // The backfill asks for the current month only, at Polygon and then Yahoo.
        const [month] = backfillMonths(localMidnight(today));
        await settle(symbol, { aggs: 1, yahoo: 2 });
        expect(urlsOf(stack.upstream.polygon.about(symbol))).toEqual([detailUrl(symbol), aggsUrl(symbol, month.asked)]);
        expect(urlsOf(stack.upstream.yahoo.about(symbol))).toEqual([yahooDetailUrl(symbol), yahooPriceUrl(symbol, month.asked)]);
      }
    });

    test("is refused when neither Polygon nor Yahoo knows it, without asking again", async () => {
      const owner = await person("hunknown");
      const symbol = ticker("NOPE");
      const message = failed(`Ticker symbol "${symbol}" could not be validated. Please check the symbol and try again.`);
      for (let i = 0; i < 2; i++) {
        expect((await post(owner.client, { account_id: owner.account_id, ticker_symbol: symbol, quantity: 1 })).json).toEqual(message);
      }
      expect(urlsOf(stack.upstream.polygon.about(symbol))).toEqual([detailUrl(symbol)]);
      expect(urlsOf(stack.upstream.yahoo.about(symbol))).toEqual([yahooDetailUrl(symbol)]);
      expect(await storedRows(stack, "holdings", { account_id: owner.account_id })).toEqual([]);
      expect(await storedRows(stack, "snapshots", { holding_account_id: owner.account_id })).toEqual([]);
    });

    test("passes on why Polygon or Yahoo refused, without falling back on a refusal", async () => {
      const owner = await person("hrefused");
      const { polygon, yahoo } = stack.upstream;
      const cases: [string, (symbol: string) => void, string, number][] = [
        [ticker("PLAN"), (s) => polygon.respond({ ticker: s }, polygonAnswer.planLimit()), "Your plan doesn't include this data timeframe. Please upgrade your plan at https://polygon.io/pricing", 0],
        [ticker("PLANB"), (s) => polygon.respond({ ticker: s }, polygonAnswer.planLimit(null)), "Polygon plan does not include data for {s}", 0],
        [ticker("BUSY"), (s) => polygon.respond({ ticker: s }, polygonAnswer.rateLimited()), "You've exceeded the maximum requests per minute, please wait or upgrade your subscription to continue. https://polygon.io/pricing", 0],
        [ticker("ERR"), (s) => polygon.respond({ ticker: s }, polygonAnswer.error("Unknown API Key")), "Unknown API Key", 0],
        [ticker("ERRB"), (s) => polygon.respond({ ticker: s }, polygonAnswer.error(null, 400)), "Polygon refused the lookup for {s} (HTTP 400)", 0],
        [ticker("HTML"), (s) => polygon.respond({ ticker: s }, polygonAnswer.status(200, "<html>oops</html>")), "Failed to fetch ticker details for {s}: JSON Parse error: Unrecognized token '<'", 0],
        [ticker("YBUSY"), (s) => yahoo.respond({ ticker: s }, yahooAnswer.rateLimited()), "Market data is busy right now; retry the lookup for {s} in a moment.", 1],
        [ticker("YBAD"), (s) => yahoo.respond({ ticker: s }, yahooAnswer.status(500, "Internal error")), "Bad response for {s}: JSON Parse error: Unexpected identifier \"Internal\"", 1],
      ];
      for (const [symbol, script, message, yahooCalls] of cases) {
        script(symbol);
        const result = await post(owner.client, { account_id: owner.account_id, ticker_symbol: symbol, quantity: 1 });
        expect([symbol, result.json]).toEqual([symbol, failed(message.replace("{s}", symbol))]);
        expect([symbol, yahoo.about(symbol).length]).toEqual([symbol, yahooCalls]);
      }
      expect(await storedRows(stack, "holdings", { account_id: owner.account_id })).toEqual([]);
    });

    test("stores what Polygon said even when the security row cannot hold it", async () => {
      const owner = await person("hlong");
      const symbol = ticker("WIDE");
      stack.upstream.polygon.setTicker(symbol, { detail: { name: "N".repeat(300), currency_name: "usd" } });
      const today = localDay(new Date());
      const result = await post(owner.client, { account_id: owner.account_id, ticker_symbol: symbol, quantity: 1, snapshot_date: today }, MINTS_AN_ID);
      expect(result.json.status).toBe("success");
      const { security_id, snapshot_id } = result.body;
      // The security write failed and was logged; the snapshot and holding name it all the same.
      expect(await storedRow(stack, "securities", security_id)).toBeUndefined();
      expect(await storedSnapshot(snapshot_id)).toMatchObject({ holding_security_id: security_id, quantity: 1 });
      expect(await storedHolding(`${owner.account_id}-${security_id}`)).toMatchObject({ security_id });
      // With no security row, the backfill has nothing to price.
      await stack.waitForLog("backfill: no security row for ref");
      expect(urlsOf(stack.upstream.polygon.about(symbol))).toEqual([detailUrl(symbol)]);
    });

    test("fails as a server error when the detail carries no currency", async () => {
      const owner = await person("hnocurrency");
      const symbol = ticker("NOCUR");
      stack.upstream.polygon.respond({ ticker: symbol, endpoint: "detail" }, polygonAnswer.json(200, { status: "OK", results: { ticker: symbol, name: "No Currency" } }));
      const result = await post(owner.client, { account_id: owner.account_id, ticker_symbol: symbol, quantity: 1 });
      expect(result.status).toBe(500);
      expect(result.json).toEqual(SERVER_ERROR);
      const { discord } = stack.upstream;
      await stack.waitFor(() => discord.alarms().some((alarm) => alarm.title.endsWith("Route Error: POST /snapshots/holding")), { what: "the route error alarm" });
      expect(discord.alarms().find((alarm) => alarm.title.endsWith("Route Error: POST /snapshots/holding"))?.description).toBe(
        "**Error:** undefined is not an object (evaluating 'currency_name.toUpperCase')",
      );
      expect(await storedRows(stack, "securities", { ticker_symbol: symbol })).toEqual([]);
    });

    test("spends the caller's lookup budget, shared with validate-ticker, and a stored ticker needs none", async () => {
      const owner = await person("hbudget");
      const { symbol: stored } = await cashSecurity();
      const asked: string[] = [];
      for (let i = 0; i < 10; i++) {
        const symbol = ticker("SPEND");
        asked.push(symbol);
        const result = await post(owner.client, { account_id: owner.account_id, ticker_symbol: symbol, quantity: 1 });
        expect(result.json).toEqual(failed(`Ticker symbol "${symbol}" could not be validated. Please check the symbol and try again.`));
      }
      const over = ticker("OVER");
      expect((await post(owner.client, { account_id: owner.account_id, ticker_symbol: over, quantity: 1 })).json).toEqual(SHED);
      expect((await owner.client.post("/validate-ticker", { ticker_symbol: over })).json).toEqual(SHED);
      expect(stack.upstream.polygon.about(over)).toEqual([]);
      // The budget is checked after the stored securities.
      expect((await post(owner.client, { account_id: owner.account_id, ticker_symbol: stored, quantity: 1, snapshot_date: "2026-01-05" })).json.status).toBe("success");
      // And after the account: an unknown account is refused first.
      expect((await post(owner.client, { account_id: "no-such-account", ticker_symbol: over, quantity: 1 })).json).toEqual(NO_ACCOUNT);
      // Another user has a budget of their own.
      const other = await person("hbudget-other");
      expect((await post(other.client, { account_id: other.account_id, ticker_symbol: over, quantity: 1 })).json).toEqual(
        failed(`Ticker symbol "${over}" could not be validated. Please check the symbol and try again.`),
      );
    });
  });

  describe("the monthly backfill it starts", () => {
    test("skips months that already have a price, and carries on past a refusal and a miss", async () => {
      const owner = await person("hbackfill");
      const symbol = ticker("FILL");
      const security_id = await seedSecurity(stack, `sec-${symbol}`, { ticker_symbol: symbol, name: "Fill Fund", type: "etf" });
      const from = new Date(new Date().getFullYear(), new Date().getMonth() - 4, 3);
      const months = backfillMonths(from);
      expect(months).toHaveLength(5);
      // A price already stored in the second month, at its middle so no zone moves it.
      await seedSnapshot(stack, { snapshot_id: `${security_id}-existing`, snapshot_type: "security", snapshot_date: `${months[1].month}-14T12:00:00Z`, security_id, close_price: 1 });
      // The first month is refused; the third and fifth Polygon has no price for, nor Yahoo.
      stack.upstream.polygon.setTicker(symbol, { bars: [{ date: months[0].asked, close: 10 }, { date: months[3].asked, close: 13 }] });
      stack.upstream.polygon.respond({ ticker: symbol, endpoint: "aggs", times: 1 }, polygonAnswer.error("Something went wrong"));
      const result = await post(owner.client, { account_id: owner.account_id, security_id, quantity: 1, snapshot_date: localDay(from) });
      expect(result.json).toEqual({ status: "success", body: { snapshot_id: `holding-${owner.account_id}-${security_id}-${squashedDay(from)}`, security_id } });
      const asked = [months[0], months[2], months[3], months[4]];
      // Only a miss asks Yahoo: a refusal does not.
      const missed = [months[2], months[4]];
      await settle(symbol, { aggs: asked.length, yahoo: missed.length });
      expect(urlsOf(stack.upstream.polygon.about(symbol))).toEqual(asked.map((m) => aggsUrl(symbol, m.asked)));
      expect(urlsOf(stack.upstream.yahoo.about(symbol))).toEqual(missed.map((m) => yahooPriceUrl(symbol, m.asked)));
      await stack.waitFor(async () => (await storedSecuritySnapshots(stack, security_id)).length === 2, { what: "the backfilled price" });
      expect((await storedSecuritySnapshots(stack, security_id)).map((s) => [s.snapshot_id, s.close_price])).toEqual([
        [`${security_id}-existing`, 1],
        [`${security_id}-${months[3].squashed}`, 13],
      ]);
    });

    test("asks nothing for cash, a CUR: ticker, a security with no ticker, or a future date", async () => {
      const owner = await person("hnofill");
      const curSymbol = ticker("CUR:X");
      const cur = await seedSecurity(stack, `sec-cur-${tickers}`, { ticker_symbol: curSymbol, type: "equity" });
      const none = await seedSecurity(stack, `sec-none-${tickers}`, { ticker_symbol: null, type: "equity" });
      const futureSymbol = ticker("LATER");
      const future = await seedSecurity(stack, `sec-${futureSymbol}`, { ticker_symbol: futureSymbol, type: "equity" });
      const { symbol: cashSymbol, security_id: cash } = await cashSecurity();
      const nextYear = `${new Date().getFullYear() + 1}-06-15`;
      for (const [security_id, snapshot_date] of [[cash, "2025-01-15"], [cur, "2025-01-15"], [none, "2025-01-15"], [future, nextYear]]) {
        expect((await post(owner.client, { account_id: owner.account_id, security_id, quantity: 1, snapshot_date })).json.status).toBe("success");
      }
      // A backfill that asks for one price, started after them, has finished after them.
      const sentinel = ticker("AFTER");
      const after = await seedSecurity(stack, `sec-${sentinel}`, { ticker_symbol: sentinel, type: "equity" });
      expect((await post(owner.client, { account_id: owner.account_id, security_id: after, quantity: 1 })).json.status).toBe("success");
      await settle(sentinel, { aggs: 1, yahoo: 1 });
      for (const symbol of [curSymbol, futureSymbol, cashSymbol]) expect([symbol, stack.upstream.polygon.about(symbol)]).toEqual([symbol, []]);
      expect(await storedRows(stack, "snapshots", { security_id: future })).toEqual([]);
    });

    test("stops at sixty months", async () => {
      const owner = await person("hcap");
      const symbol = ticker("OLD");
      const security_id = await seedSecurity(stack, `sec-${symbol}`, { ticker_symbol: symbol, type: "etf" });
      const from = new Date(new Date().getFullYear() - 6, 0, 10);
      const months = backfillMonths(from);
      expect(months).toHaveLength(60);
      stack.upstream.polygon.setTicker(symbol, { bars: months.map((m) => ({ date: m.asked, close: 1 })) });
      expect((await post(owner.client, { account_id: owner.account_id, security_id, quantity: 1, snapshot_date: localDay(from) })).json.status).toBe("success");
      await settle(symbol, { aggs: 60 });
      expect(urlsOf(stack.upstream.polygon.about(symbol))).toEqual(months.map((m) => aggsUrl(symbol, m.asked)));
      await stack.waitFor(async () => (await storedSecuritySnapshots(stack, security_id)).length === 60, { what: "sixty prices" });
    });
  });
});

// ---------------------------------------------------------------------------
// POST /snapshots/holding: update
// ---------------------------------------------------------------------------

describe("POST /snapshots/holding with a snapshot id updates", () => {
  /** A holding snapshot of `owner`'s account, stored as given. */
  const seedHoldingSnapshot = async (owner: { user_id: string; account_id: string }, security_id: string, row: Record<string, unknown> = {}) => {
    const snapshot_id = `holding-${owner.account_id}-${security_id}-${++counter}`;
    await seedSnapshot(stack, { snapshot_id, user_id: owner.user_id, snapshot_type: "holding", snapshot_date: "2026-02-10T00:00:00Z", holding_account_id: owner.account_id, holding_security_id: security_id, quantity: 10, cost_basis: 100, institution_price: 12, institution_value: 120, ...row });
    return snapshot_id;
  };

  test("changes only the fields given, answers the id and security, and syncs the holding from the snapshot", async () => {
    const owner = await person("hupdate");
    const { security_id } = await cashSecurity();
    const snapshot_id = await seedHoldingSnapshot(owner, security_id);
    const result = await post(owner.client, { snapshot_id, quantity: 11, account_id: "ignored", security_id: "ignored" });
    expect(result.json).toEqual({ status: "success", body: { snapshot_id, security_id } });
    expect(await storedSnapshot(snapshot_id)).toEqual(holdingSnapshotRow({ snapshot_id, user_id: owner.user_id, day: "2026-02-10", account_id: owner.account_id, security_id, quantity: 11, cost_basis: 100, institution_price: 12, institution_value: 120 }));
    expect(await storedHolding(`${owner.account_id}-${security_id}`)).toEqual(
      holdingRow({ user_id: owner.user_id, account_id: owner.account_id, security_id, quantity: 11, cost_basis: 100, institution_price: 12, institution_value: 120, as_of: "2026-02-10T00:00:00.000Z" }),
    );

    // Nulls clear; the holding then derives its value from quantity times price.
    await post(owner.client, { snapshot_id, cost_basis: null, institution_value: null, institution_price: 2.5 });
    expect(await storedSnapshot(snapshot_id)).toEqual(holdingSnapshotRow({ snapshot_id, user_id: owner.user_id, day: "2026-02-10", account_id: owner.account_id, security_id, quantity: 11, institution_price: 2.5 }));
    expect(await storedHolding(`${owner.account_id}-${security_id}`)).toEqual(
      holdingRow({ user_id: owner.user_id, account_id: owner.account_id, security_id, quantity: 11, cost_basis: null, institution_price: 2.5, institution_value: 27.5, as_of: "2026-02-10T00:00:00.000Z" }),
    );
    // No quantity and no price: zeros.
    await post(owner.client, { snapshot_id, quantity: null, institution_price: null });
    expect(await storedHolding(`${owner.account_id}-${security_id}`)).toEqual(
      holdingRow({ user_id: owner.user_id, account_id: owner.account_id, security_id, quantity: 0, cost_basis: null, institution_price: 0, institution_value: 0, as_of: "2026-02-10T00:00:00.000Z" }),
    );
  });

  test("moves the snapshot to the UTC day of the new date's local midnight", async () => {
    const owner = await person("hredate");
    const { security_id } = await cashSecurity();
    const snapshot_id = await seedHoldingSnapshot(owner, security_id);
    for (const snapshot_date of ["2026-03-01", "2026-03-01T23:30:00Z", "2026-03-02T00:30:00"]) {
      expect((await post(owner.client, { snapshot_id, snapshot_date })).json).toEqual({ status: "success", body: { snapshot_id, security_id } });
      const date = /T/.test(snapshot_date) ? new Date(snapshot_date) : localMidnight(snapshot_date);
      const day = date.toISOString().slice(0, 10);
      // The id keeps its day; only the stored date moves.
      expect(await storedSnapshot(snapshot_id)).toMatchObject({ snapshot_date: `${day}T00:00:00+00:00` });
      expect(await storedHolding(`${owner.account_id}-${security_id}`)).toMatchObject({ institution_price_as_of: day });
    }
  });

  test("resolves a new ticker to its security, as the create does", async () => {
    const owner = await person("hretick");
    const { security_id } = await cashSecurity();
    const { symbol: otherSymbol, security_id: other } = await cashSecurity();
    const snapshot_id = await seedHoldingSnapshot(owner, security_id);
    expect((await post(owner.client, { snapshot_id, ticker_symbol: ` ${otherSymbol.toLowerCase()}` })).json).toEqual({ status: "success", body: { snapshot_id, security_id: other } });
    expect(await storedSnapshot(snapshot_id)).toMatchObject({ holding_security_id: other, quantity: 10 });
    // The holding row of the new security is written; the old one stays.
    expect(await storedHolding(`${owner.account_id}-${other}`)).toMatchObject({ security_id: other, quantity: 10 });
    expect(await storedHolding(`${owner.account_id}-${security_id}`)).toBeUndefined();

    // A ticker Polygon knows is looked up and stored.
    const symbol = ticker("NEWT");
    stack.upstream.polygon.setTicker(symbol, { detail: { name: "New Ticker Fund", currency_name: "cad" } });
    const result = await post(owner.client, { snapshot_id, ticker_symbol: symbol, quantity: 1 }, MINTS_AN_ID);
    expect(result.json.status).toBe("success");
    expect(withoutStamps(await storedRow(stack, "securities", result.body.security_id))).toEqual(lookedUpSecurity(result.body.security_id, symbol, "New Ticker Fund", "CAD"));
    // An update starts no backfill.
    expect(urlsOf(stack.upstream.polygon.about(symbol))).toEqual([detailUrl(symbol)]);

    // One no one knows is refused, and nothing is written.
    const unknown = ticker("NOT");
    expect((await post(owner.client, { snapshot_id, ticker_symbol: unknown, quantity: 99 })).json).toEqual(
      failed(`Ticker symbol "${unknown}" could not be validated. Please check the symbol and try again.`),
    );
    expect(await storedSnapshot(snapshot_id)).toMatchObject({ quantity: 1 });
  });

  test("refuses what it cannot apply, checking the amounts before the lookup and the ticker before the date", async () => {
    const owner = await person("hupvalid");
    const { security_id } = await cashSecurity();
    const snapshot_id = await seedHoldingSnapshot(owner, security_id);
    const before = await storedSnapshot(snapshot_id);
    const cases: [unknown, unknown][] = [
      [{ snapshot_id }, failed("no fields to update")],
      [{ snapshot_id, snapshot_date: null, ticker_symbol: "  " }, failed("no fields to update")],
      [{ snapshot_id, snapshot_date: "", ticker_symbol: 5 }, failed("no fields to update")],
      [{ snapshot_id, account_id: owner.account_id, security_id }, failed("no fields to update")],
      ...["1", true, [], {}].map((quantity): [unknown, unknown] => [{ snapshot_id, quantity }, failed("Field quantity must be a number")]),
      [{ snapshot_id, quantity: 1e9 }, failed("Field quantity must be at most 999999999.999999")],
      [{ snapshot_id, cost_basis: "1" }, failed("Field cost_basis must be a number")],
      [{ snapshot_id, cost_basis: 1e13 }, failed("Field cost_basis must be at most 9999999999999.99")],
      [{ snapshot_id, institution_price: false }, failed("Field institution_price must be a number")],
      [{ snapshot_id, institution_price: -1e9 }, failed("Field institution_price must be at most 999999999.999999")],
      [{ snapshot_id, institution_value: "1" }, failed("Field institution_value must be a number")],
      [{ snapshot_id, institution_value: 1e13 }, failed("Field institution_value must be at most 9999999999999.99")],
      [{ snapshot_id: "no-such-snapshot", quantity: "x" }, failed("Field quantity must be a number")],
      [{ snapshot_id: "no-such-snapshot", quantity: 1 }, NOT_FOUND],
      [{ snapshot_id, ticker_symbol: "BAD TICKER", quantity: 1 }, failed(TICKER_MESSAGE)],
      [{ snapshot_id, ticker_symbol: "ABCDEFGHIJKLMNOPQ" }, failed(TICKER_MESSAGE)],
      ...[5, true, [], {}].map((snapshot_date): [unknown, unknown] => [{ snapshot_id, snapshot_date, quantity: 1 }, failed("snapshot_date must be a string")]),
      [{ snapshot_id, snapshot_date: "yesterday" }, failed("snapshot_date is not a valid date")],
      // The quantity times price the holding would derive must fit, counting what is stored.
      [{ snapshot_id, quantity: 1e8, institution_price: 1e8, institution_value: null }, failed("Field institution_value must be at most 9999999999999.99")],
    ];
    for (const [body, answer] of cases) {
      const result = await post(owner.client, body);
      expect([body, result.status, result.json]).toEqual([body, 200, answer]);
    }
    expect(await storedSnapshot(snapshot_id)).toEqual(before);

    // Values at their bounds, and nulls, are written.
    for (const body of [
      { quantity: 999999999.999999, institution_value: 1 },
      { quantity: -999999999.999999, cost_basis: 9999999999999.99, institution_price: null },
      { quantity: 0, cost_basis: -9999999999999.99, institution_price: 999999999.999999, institution_value: 9999999999999.99 },
      { quantity: null, cost_basis: null, institution_price: null, institution_value: null },
    ]) {
      expect([body, (await post(owner.client, { snapshot_id, ...body })).json]).toEqual([body, { status: "success", body: { snapshot_id, security_id } }]);
      expect(await storedSnapshot(snapshot_id)).toMatchObject(body);
    }

    // The stored value spares the derivation; once it is cleared, the stored quantity counts.
    const big = await seedHoldingSnapshot(owner, security_id, { quantity: 1e8, institution_price: null, institution_value: 5 });
    expect((await post(owner.client, { snapshot_id: big, institution_price: 1e8 })).json).toEqual({ status: "success", body: { snapshot_id: big, security_id } });
    expect((await post(owner.client, { snapshot_id: big, institution_value: null })).json).toEqual(failed("Field institution_value must be at most 9999999999999.99"));
    expect(await storedSnapshot(big)).toMatchObject({ quantity: 1e8, institution_price: 1e8, institution_value: 5 });
  });

  test("updates a member's snapshot and syncs the member's holding, and refuses a stranger's, a deleted one or another type", async () => {
    const [owner, member, stranger] = [await person("hupgroup"), await person("hupgroup-member"), await person("hupgroup-stranger")];
    await shareData(stack, owner.user_id, member.user_id);
    const { security_id } = await cashSecurity();
    const theirs = await seedHoldingSnapshot(member, security_id);
    expect((await post(owner.client, { snapshot_id: theirs, quantity: 3 })).json).toEqual({ status: "success", body: { snapshot_id: theirs, security_id } });
    expect(await storedSnapshot(theirs)).toMatchObject({ user_id: member.user_id, quantity: 3 });
    expect(await storedHolding(`${member.account_id}-${security_id}`)).toMatchObject({ user_id: member.user_id, quantity: 3 });

    const strangers = await seedHoldingSnapshot(stranger, security_id);
    const deleted = await seedHoldingSnapshot(owner, security_id, { is_deleted: true });
    const balance = await seedSnapshot(stack, { snapshot_id: `hup-balance-${counter}`, user_id: owner.user_id, snapshot_type: "account_balance", snapshot_date: "2026-02-10T00:00:00Z", account_id: owner.account_id });
    for (const snapshot_id of [strangers, deleted, balance, "snap-none"]) {
      expect([snapshot_id, (await post(owner.client, { snapshot_id, quantity: 1 })).json]).toEqual([snapshot_id, NOT_FOUND]);
    }
    expect(await storedSnapshot(strangers)).toMatchObject({ quantity: 10 });
    // An id that is not a string is looked up as the value it is.
    expect((await post(owner.client, { snapshot_id: {}, quantity: 1 })).json).toEqual(NOT_FOUND);
    expect((await post(owner.client, { snapshot_id: ["x"], quantity: 1 })).json).toEqual(NOT_FOUND);
  });

  test("updates a snapshot whose account is gone without touching any holding", async () => {
    const owner = await person("hupgone");
    const { security_id } = await cashSecurity();
    const snapshot_id = await seedHoldingSnapshot(owner, security_id);
    await softDelete(stack, "accounts", owner.account_id);
    expect((await post(owner.client, { snapshot_id, quantity: 4 })).json).toEqual({ status: "success", body: { snapshot_id, security_id } });
    expect(await storedSnapshot(snapshot_id)).toMatchObject({ quantity: 4 });
    expect(await storedHolding(`${owner.account_id}-${security_id}`)).toBeUndefined();
  });

  test("syncs the holding from the snapshot as stored when the update touches no row, and fails as a server error when it fails", async () => {
    const owner = await person("hupbroken");
    const { security_id } = await cashSecurity();
    const snapshot_id = await seedHoldingSnapshot(owner, security_id);
    const when = `NEW.snapshot_id = '${snapshot_id}'`;
    await withWritesBroken(stack, "snapshots", { event: "UPDATE", when, mode: "skip" }, async () => {
      expect((await post(owner.client, { snapshot_id, quantity: 77 })).json).toEqual({ status: "success", body: { snapshot_id, security_id } });
    });
    expect(await storedSnapshot(snapshot_id)).toMatchObject({ quantity: 10 });
    expect(await storedHolding(`${owner.account_id}-${security_id}`)).toMatchObject({ quantity: 10, institution_value: 120 });
    await withWritesBroken(stack, "snapshots", { event: "UPDATE", when, mode: "raise" }, async () => {
      const result = await post(owner.client, { snapshot_id, quantity: 78 });
      expect(result.status).toBe(500);
      expect(result.json).toEqual(SERVER_ERROR);
    });
    expect(await storedSnapshot(snapshot_id)).toMatchObject({ quantity: 10 });
  });

  test("fails as a server error on a numeric snapshot id", async () => {
    // The id goes to the varchar column as a number, which Postgres cannot compare.
    const owner = await person("hupnumber");
    const result = await post(owner.client, { snapshot_id: 5, quantity: 1 });
    expect(result.status).toBe(500);
    expect(result.json).toEqual(SERVER_ERROR);
  });
});

// ---------------------------------------------------------------------------
// DELETE /snapshots/holding
// ---------------------------------------------------------------------------

describe("DELETE /snapshots/holding", () => {
  const seedOne = async (owner: { user_id: string; account_id: string }, row: Record<string, unknown> = {}) => {
    const snapshot_id = `hdel-${++counter}`;
    await seedSnapshot(stack, { snapshot_id, user_id: owner.user_id, snapshot_type: "holding", snapshot_date: "2026-02-10T00:00:00Z", holding_account_id: owner.account_id, holding_security_id: "sec-x", quantity: 1, ...row });
    await stack.db.query("UPDATE snapshots SET updated = '2026-01-01T00:00:00Z' WHERE snapshot_id = $1", [snapshot_id]);
    return snapshot_id;
  };

  test("soft-deletes the caller's and a member's holding snapshot, once", async () => {
    const [owner, member] = [await person("hdel"), await person("hdel-member")];
    await shareData(stack, owner.user_id, member.user_id);
    for (const snapshot_id of [await seedOne(owner), await seedOne(member)]) {
      const result = await owner.client.delete(`/snapshots/holding?id=${snapshot_id}`);
      expect([snapshot_id, result.status, result.json]).toEqual([snapshot_id, 200, SUCCESS]);
      const row = await storedRow(stack, "snapshots", snapshot_id);
      expect(row?.is_deleted).toBe(true);
      expect(Date.parse(row!.updated as string)).toBeGreaterThan(Date.parse("2026-01-02T00:00:00Z"));
      // A deleted one is not found again.
      expect((await owner.client.delete(`/snapshots/holding?id=${snapshot_id}`)).json).toEqual(NOT_FOUND);
    }
    // Holdings are left alone.
    expect(await storedRows(stack, "holdings", { account_id: owner.account_id })).toEqual([]);
  });

  test("refuses a stranger's, a missing one, and snapshots of other types", async () => {
    const [owner, stranger] = [await person("hdel-refused"), await person("hdel-stranger")];
    const theirs = await seedOne(stranger);
    const balance = await seedSnapshot(stack, { snapshot_id: `hdel-balance-${counter}`, user_id: owner.user_id, snapshot_type: "account_balance", snapshot_date: "2026-02-10T00:00:00Z", account_id: owner.account_id });
    const price = await seedSnapshot(stack, { snapshot_id: `hdel-price-${counter}`, snapshot_type: "security", snapshot_date: "2026-02-10T00:00:00Z", security_id: "sec-x", close_price: 1 });
    for (const snapshot_id of [theirs, balance, price, "no-such-snapshot", "%C2%85"]) {
      expect([snapshot_id, (await owner.client.delete(`/snapshots/holding?id=${snapshot_id}`)).json]).toEqual([snapshot_id, NOT_FOUND]);
    }
    for (const snapshot_id of [theirs, balance, price]) expect((await storedRow(stack, "snapshots", snapshot_id))?.is_deleted).toBe(false);
  });

  test("answers that it found nothing when the row goes before the delete, and fails as a server error when the delete fails", async () => {
    const owner = await person("hdel-broken");
    const snapshot_id = await seedOne(owner);
    const when = `NEW.snapshot_id = '${snapshot_id}'`;
    await withWritesBroken(stack, "snapshots", { event: "UPDATE", when, mode: "skip" }, async () => {
      expect((await owner.client.delete(`/snapshots/holding?id=${snapshot_id}`)).json).toEqual(NOT_FOUND);
    });
    await withWritesBroken(stack, "snapshots", { event: "UPDATE", when, mode: "raise" }, async () => {
      const result = await owner.client.delete(`/snapshots/holding?id=${snapshot_id}`);
      expect(result.status).toBe(500);
      expect(result.json).toEqual(SERVER_ERROR);
    });
    const { discord } = stack.upstream;
    const title = "🚨 Budget Server Error: Route Error: DELETE /snapshots/holding";
    await stack.waitFor(() => discord.alarms().some((alarm) => alarm.title === title), { what: "the route error alarm" });
    expect(discord.alarms().find((alarm) => alarm.title === title)?.description).toBe("**Error:** conformance: refused");
    expect((await storedRow(stack, "snapshots", snapshot_id))?.is_deleted).toBe(false);
  });

  test("needs one id", async () => {
    const owner = await person("hdel-query");
    for (const [query, message] of [
      ["", "Missing required parameter: id"],
      ["?snapshot_id=x", "Missing required parameter: id"],
      ["?id=a&id=b", "Parameter id must be a single value, not an array"],
      ["?id=", "Parameter id cannot be empty"],
      ["?id=%20%0A", "Parameter id cannot be empty"],
    ]) {
      expect([query, (await owner.client.delete(`/snapshots/holding${query}`)).json]).toEqual([query, failed(message)]);
    }
  });
});

// ---------------------------------------------------------------------------
// Market data that waits, or is not configured
// ---------------------------------------------------------------------------

describe("with Polygon's rate gate on", () => {
  let gated: Stack;
  beforeAll(async () => {
    gated = await startStack();
    // A fresh benchmark price, so the refresh at the next start spends no slot of the gate.
    await seedSnapshot(gated, { snapshot_id: "benchmark-VOO-fresh", snapshot_type: "security", snapshot_date: new Date().toISOString(), security_id: "benchmark-VOO", close_price: 1 });
    await gated.restart({ POLYGON_RATE_LIMIT_PER_MIN: "1" });
    stacks.push(gated);
  });

  test("a lookup whose slot frees later than a person would wait says at once that the market data is busy", async () => {
    const owner = await person("hgated", gated);
    const [first, second] = [ticker("GATEA"), ticker("GATEB")];
    gated.upstream.polygon.setTicker(first, { detail: { name: "Gate A", currency_name: "usd" } });
    gated.upstream.polygon.setTicker(second, { detail: { name: "Gate B", currency_name: "usd" } });
    // Dated next year, so neither post starts a backfill that would queue behind the gate.
    const later = `${new Date().getFullYear() + 1}-01-15`;
    // The first lookup takes the minute's one slot.
    const result = await post(owner.client, { account_id: owner.account_id, ticker_symbol: first, quantity: 1, snapshot_date: later }, MINTS_AN_ID);
    expect(result.json.status).toBe("success");
    expect(urlsOf(gated.upstream.polygon.about(first))).toEqual([detailUrl(first)]);
    const started = Date.now();
    expect((await post(owner.client, { account_id: owner.account_id, ticker_symbol: second, quantity: 1, snapshot_date: later })).json).toEqual(
      failed(`Market data is busy right now; retry the lookup for ${second} in a moment.`),
    );
    // The next slot frees a minute after the first: past the foreground wait, so the lookup sheds without waiting.
    expect(Date.now() - started).toBeLessThan(4_500);
    expect(urlsOf(gated.upstream.polygon.about(second))).toEqual([]);
    expect(await storedRows(gated, "securities", { ticker_symbol: second })).toEqual([]);
  });
});

describe("without a Polygon key", () => {
  test("a new ticker is refused as not configured, and a stored one still works", async () => {
    const keyless = await startStack({ env: { POLYGON_API_KEY: undefined } });
    stacks.push(keyless);
    const owner = await person("hkeyless", keyless);
    const symbol = ticker("KEYLESS");
    expect((await post(owner.client, { account_id: owner.account_id, ticker_symbol: symbol, quantity: 1 })).json).toEqual(
      failed("Market data API is not configured. Contact your administrator."),
    );
    expect(keyless.upstream.polygon.about(symbol)).toEqual([]);
    expect(keyless.upstream.yahoo.about(symbol)).toEqual([]);
    const { security_id } = await cashSecurity(keyless);
    expect((await post(owner.client, { account_id: owner.account_id, security_id, quantity: 1, snapshot_date: "2026-01-01" })).json).toEqual({
      status: "success",
      body: { snapshot_id: `holding-${owner.account_id}-${security_id}-20260101`, security_id },
    });
  });
});
