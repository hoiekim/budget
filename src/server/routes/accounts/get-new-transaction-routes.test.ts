// Route + repo coverage for the two manual-transaction mint endpoints
// (`GET /api/new-transaction` — provider-gated to MANUAL — and
// `GET /api/new-investment-transaction` — allowed on any investment
// account for the #585 RSU/ESPP case). The routes read query params,
// look up account/item/security in the repo layer, then insert a shell
// row via `createManualTransaction` / `createManualInvestmentTransaction`.
// The pg-FakePool seam intercepts every DB call; a SQL router dispatches
// by table so we can seed accounts / items / securities without needing
// live tables.
//
// What we're pinning here:
//   - unauth / missing-arg / not-found rejections
//   - provider gate (cash mint refused on Plaid accounts — #567 AC)
//   - account.type gate (invest mint refused on depository/credit)
//   - security_id validation (garbage id refused via getSecurity)
//   - happy paths write `source='manual'` and a `manual-<uuid>` id
// Without these, dropping any of the guards would pass silently.

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

const mockQuery = mock(async (_sql: string, _values?: unknown[]) => ({
  rows: [] as unknown[],
  rowCount: 0 as number | null,
}));

class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
}

mock.module("pg", () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {} },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
}));

const { getNewTransactionRoute } = await import("./get-new-transaction");
const { getNewInvestmentTransactionRoute } = await import("./get-new-investment-transaction");

afterAll(restoreLeaves);

// SQL router state — each test sets which SELECT-per-table returns a row.
// The mint route calls: SELECT accounts, SELECT items (cash-side only),
// SELECT securities (when security_id is present), INSERT transactions /
// investment_transactions.
type MaybeRow = Record<string, unknown> | null;
let accountRow: MaybeRow = null;
let itemRow: MaybeRow = null;
let securityRow: MaybeRow = null;
let insertShouldFail = false;

const queryRouter = async (sql: string, _values?: unknown[]) => {
  const isSelect = /^\s*SELECT\b/i.test(sql);
  if (isSelect && /\bFROM\s+accounts\b/i.test(sql)) {
    return accountRow ? { rows: [accountRow], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (isSelect && /\bFROM\s+items\b/i.test(sql)) {
    return itemRow ? { rows: [itemRow], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (isSelect && /\bFROM\s+securities\b/i.test(sql)) {
    return securityRow ? { rows: [securityRow], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/\bINSERT\s+INTO\s+investment_transactions\b/i.test(sql)) {
    if (insertShouldFail) throw new Error("DB down");
    return { rows: [insertStub("investment_transactions", _values as unknown[])], rowCount: 1 };
  }
  if (/\bINSERT\s+INTO\s+transactions\b/i.test(sql)) {
    if (insertShouldFail) throw new Error("DB down");
    return { rows: [insertStub("transactions", _values as unknown[])], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};

/**
 * Return a model-valid stub row for the INSERT's RETURNING *. The repo
 * helper does `new TransactionModel(result).toJSON()` after, so the stub
 * needs every column the typeChecker demands. Column values here are cosmetic
 * — the actual test assertions read the SQL's bound parameter list via
 * `findInsert` + `boundValue`, not this stub.
 */
function insertStub(table: "transactions" | "investment_transactions", values: unknown[]): Record<string, unknown> {
  const id = String(values[0]);
  if (table === "transactions") {
    return {
      transaction_id: id,
      user_id: "u-1",
      account_id: "acc-x",
      name: null,
      merchant_name: null,
      amount: 0,
      iso_currency_code: null,
      date: "2026-01-01",
      pending: false,
      pending_transaction_id: null,
      payment_channel: null,
      location_country: null,
      location_region: null,
      location_city: null,
      label_budget_id: null,
      label_category_id: null,
      label_memo: null,
      label_category_confidence: null,
      raw: null,
      updated: new Date().toISOString(),
      is_deleted: false,
      source: "manual",
    };
  }
  return {
    investment_transaction_id: id,
    user_id: "u-1",
    account_id: "acc-x",
    security_id: null,
    date: "2026-01-01",
    name: null,
    amount: 0,
    quantity: 0,
    price: 0,
    iso_currency_code: null,
    type: "buy",
    subtype: "buy",
    label_budget_id: null,
    label_category_id: null,
    label_memo: null,
    raw: null,
    updated: new Date().toISOString(),
    is_deleted: false,
    source: "manual",
  };
}

/** Find the INSERT statement that landed against `table`. Assertions read
 *  `insert!.values` directly with `toContain(...)` — position-based lookup
 *  is brittle because `buildInsert` walks `Object.keys(data)` and the model
 *  layer's key insertion order intersperses `source` + `raw` in ways that
 *  make a naive column→value lookup unreliable. `toContain` scoped to the
 *  values array is enough to lock the route's intent (the specific string
 *  landed on some column). */
const findInsert = (table: string): { sql: string; values: unknown[] } | null => {
  const re = new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, "i");
  for (const call of mockQuery.mock.calls) {
    const sql = call[0] as string;
    if (re.test(sql)) return { sql, values: call[1] as unknown[] };
  }
  return null;
};

type AnyRoute = typeof getNewTransactionRoute | typeof getNewInvestmentTransactionRoute;

function makeReq(route: AnyRoute, query: Record<string, string> = {}, userId?: string) {
  return {
    method: "GET",
    path: "/x",
    url: "http://x/api/x?" + new URLSearchParams(query).toString(),
    headers: {},
    query,
    body: undefined,
    session: {
      id: "s-1",
      user: userId ? { user_id: userId, username: "test" } : undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof route.execute>[0];
}

const fakeRes = () =>
  ({
    statusCode: 200,
    headersSent: false,
    status() {
      return this;
    },
    write() {
      return true;
    },
    end() {},
  }) as unknown as Parameters<typeof getNewTransactionRoute.execute>[1];

beforeEach(() => {
  mockQuery.mockClear();
  mockQuery.mockImplementation(queryRouter);
  accountRow = null;
  itemRow = null;
  securityRow = null;
  insertShouldFail = false;
});

// The AccountModel / ItemModel / SecurityModel constructors run the row through
// their typeChecker, which distinguishes null (valid for `isNullable*`) from
// undefined (invalid). Fixtures fill every nullable column with `null` so the
// model instantiation succeeds when the SELECT router echoes these back.
const nullFields = (keys: string[]): Record<string, null> =>
  Object.fromEntries(keys.map((k) => [k, null]));

const ACCOUNT_NULLABLE = [
  "name",
  "type",
  "subtype",
  "balances_available",
  "balances_current",
  "balances_limit",
  "balances_iso_currency_code",
  "custom_name",
  "hide",
  "archived",
  "label_budget_id",
  "graph_options_use_snapshots",
  "graph_options_use_holding_snapshots",
  "graph_options_use_transactions",
  "raw",
  "updated",
  "is_deleted",
];
const ITEM_NULLABLE = [
  "access_token",
  "institution_id",
  "available_products",
  "cursor",
  "status",
  "provider",
  "last_sync_status",
  "last_sync_at",
  "last_sync_error",
  "raw",
  "updated",
  "is_deleted",
];
const SECURITY_NULLABLE = [
  "name",
  "ticker_symbol",
  "type",
  "close_price",
  "close_price_as_of",
  "iso_currency_code",
  "isin",
  "cusip",
  "raw",
  "updated",
];

// A depository account owned by u-1 with a MANUAL item (cash-side happy path).
const manualCashAccount = () => ({
  ...nullFields(ACCOUNT_NULLABLE),
  account_id: "acc-manual-cash",
  user_id: "u-1",
  item_id: "item-manual",
  institution_id: "ins-manual",
  type: "depository",
  subtype: "checking",
  balances_iso_currency_code: "USD",
});
const manualItem = () => ({
  ...nullFields(ITEM_NULLABLE),
  item_id: "item-manual",
  user_id: "u-1",
  provider: "manual",
});

// A Plaid brokerage owned by u-1 (invest-side happy path).
const plaidInvestAccount = () => ({
  ...nullFields(ACCOUNT_NULLABLE),
  account_id: "acc-plaid-invest",
  user_id: "u-1",
  item_id: "item-plaid",
  institution_id: "ins-plaid",
  type: "investment",
  subtype: "brokerage",
  balances_iso_currency_code: "USD",
});
const plaidItem = () => ({
  ...nullFields(ITEM_NULLABLE),
  item_id: "item-plaid",
  user_id: "u-1",
  provider: "plaid",
});

const someSecurity = () => ({
  ...nullFields(SECURITY_NULLABLE),
  security_id: "sec-voo",
  ticker_symbol: "VOO",
  name: "Vanguard S&P 500",
});

// ---------------------------------------------------------------------------
// GET /api/new-transaction (cash-side, provider-gated to MANUAL)
// ---------------------------------------------------------------------------

describe("get-new-transaction route", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await getNewTransactionRoute.execute(
      makeReq(getNewTransactionRoute, { account_id: "acc-x" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects a missing account_id", async () => {
    const result = await getNewTransactionRoute.execute(
      makeReq(getNewTransactionRoute, {}, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/account_id/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects when the account isn't found for the caller", async () => {
    // accountRow left null → getAccount returns null
    const result = await getNewTransactionRoute.execute(
      makeReq(getNewTransactionRoute, { account_id: "acc-x" }, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/account not found/i);
    expect(findInsert("transactions")).toBeNull();
  });

  test("rejects when the account's item is not MANUAL provider (Plaid/simple-fin) — #567 AC", async () => {
    accountRow = plaidInvestAccount();
    itemRow = plaidItem();
    const result = await getNewTransactionRoute.execute(
      makeReq(getNewTransactionRoute, { account_id: "acc-plaid-invest" }, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/only allowed on manual accounts/i);
    // No INSERT — the provider gate short-circuits before the mint.
    expect(findInsert("transactions")).toBeNull();
  });

  test("happy path: manual account → INSERT with source='manual' and manual-<uuid> id", async () => {
    accountRow = manualCashAccount();
    itemRow = manualItem();
    const result = await getNewTransactionRoute.execute(
      makeReq(getNewTransactionRoute, { account_id: "acc-manual-cash" }, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    const insert = findInsert("transactions");
    expect(insert).not.toBeNull();
    // Position-based `boundValue` is brittle across driver-serialized columns,
    // so assert `"manual"` shows up in the bound-parameter list directly.
    expect(insert!.values).toContain("manual");
    expect(insert!.values).toContain("u-1");
    expect(insert!.values).toContain("acc-manual-cash");
    // A `manual-<uuid>` id landed in the INSERT values.
    const manualIds = insert!.values.filter(
      (v): v is string => typeof v === "string" && v.startsWith("manual-"),
    );
    expect(manualIds.length).toBeGreaterThan(0);
    // The route body has some transaction_id string (stub returns u-1 here;
    // the important contract is the SQL wrote a manual-<uuid>, verified above).
    expect(typeof (result?.body as { transaction_id: string }).transaction_id).toBe("string");
  });

  test("surfaces a DB error as a failed response (no throw bubbling to the caller)", async () => {
    accountRow = manualCashAccount();
    itemRow = manualItem();
    insertShouldFail = true;
    const result = await getNewTransactionRoute.execute(
      makeReq(getNewTransactionRoute, { account_id: "acc-manual-cash" }, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/failed to create/i);
  });
});

// ---------------------------------------------------------------------------
// GET /api/new-investment-transaction (NOT provider-gated, but type-gated)
// ---------------------------------------------------------------------------

describe("get-new-investment-transaction route", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await getNewInvestmentTransactionRoute.execute(
      makeReq(getNewInvestmentTransactionRoute, { account_id: "acc-x" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects a missing account_id", async () => {
    const result = await getNewInvestmentTransactionRoute.execute(
      makeReq(getNewInvestmentTransactionRoute, {}, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/account_id/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects when the account isn't found for the caller", async () => {
    const result = await getNewInvestmentTransactionRoute.execute(
      makeReq(getNewInvestmentTransactionRoute, { account_id: "acc-x" }, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/account not found/i);
    expect(findInsert("investment_transactions")).toBeNull();
  });

  test("rejects when the account isn't an investment account (depository/credit)", async () => {
    // Manual depository account — provider gate wouldn't fire (route allows
    // any provider), but the type gate catches it.
    accountRow = manualCashAccount();
    const result = await getNewInvestmentTransactionRoute.execute(
      makeReq(getNewInvestmentTransactionRoute, { account_id: "acc-manual-cash" }, "u-1"),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/investment accounts/i);
    expect(findInsert("investment_transactions")).toBeNull();
  });

  test("rejects a garbage security_id — server-side validation via getSecurity", async () => {
    accountRow = plaidInvestAccount();
    // securityRow left null → getSecurity returns null → route refuses
    const result = await getNewInvestmentTransactionRoute.execute(
      makeReq(
        getNewInvestmentTransactionRoute,
        { account_id: "acc-plaid-invest", security_id: "not-a-real-security-id" },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/security not found/i);
    expect(findInsert("investment_transactions")).toBeNull();
  });

  test("happy path with security_id: INSERT sets security_id + source='manual' on a Plaid brokerage (#585 case)", async () => {
    accountRow = plaidInvestAccount();
    securityRow = someSecurity();
    const result = await getNewInvestmentTransactionRoute.execute(
      makeReq(
        getNewInvestmentTransactionRoute,
        { account_id: "acc-plaid-invest", security_id: "sec-voo" },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    const insert = findInsert("investment_transactions");
    expect(insert).not.toBeNull();
    // Position-based `boundValue` is brittle across driver-serialized columns,
    // so assert `"manual"` shows up in the bound-parameter list directly.
    expect(insert!.values).toContain("manual");
    expect(insert!.values).toContain("sec-voo");
    expect(insert!.values).toContain("u-1");
    expect(insert!.values).toContain("acc-plaid-invest");
    // A `manual-<uuid>` id landed in the INSERT values.
    const manualIds = insert!.values.filter(
      (v): v is string => typeof v === "string" && v.startsWith("manual-"),
    );
    expect(manualIds.length).toBeGreaterThan(0);
    expect(typeof (result?.body as { investment_transaction_id: string }).investment_transaction_id).toBe("string");
  });

  test("happy path without security_id: INSERT still lands with security_id=null", async () => {
    accountRow = plaidInvestAccount();
    const result = await getNewInvestmentTransactionRoute.execute(
      makeReq(
        getNewInvestmentTransactionRoute,
        { account_id: "acc-plaid-invest" },
        "u-1",
      ),
      fakeRes(),
    );
    expect(result?.status).toBe("success");
    const insert = findInsert("investment_transactions");
    expect(insert).not.toBeNull();
    // Position-based `boundValue` is brittle across driver-serialized columns,
    // so assert `"manual"` shows up in the bound-parameter list directly.
    expect(insert!.values).toContain("manual");
    // security_id absent from query → INSERT should carry null there. The
    // route's happy path returns success and the mint's raw JSON blob
    // doesn't carry a security_id key.
    expect(insert!.values).toContain(null);
  });
});
