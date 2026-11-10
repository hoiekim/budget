// Success / side-effect coverage for POST /snapshots/holding. The sibling
// `post-holding-snapshot.test.ts` pins the cheap pre-DB validation guards;
// this file drives the two real modes (update + create) through a SQL-routing
// fake driver client so the ownership gate, the re-sync chain, the deterministic
// snapshot_id, and the no-API-key branch are actually exercised — not just the
// early returns.
//
// Routing rather than a per-call queue keeps the test robust to the extra
// writes (upsert/update) and the fire-and-forget backfill the route emits:
// only the two SELECTs are scripted (snapshots → holding rows, securities →
// security rows); everything else falls through to an empty/ok result.
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import { getSquashedDateString, LocalDate } from "common";

let snapshotRows: Record<string, unknown>[] = [];
let securityRows: Record<string, unknown>[] = [];
let accountRows: Record<string, unknown>[] = [];

const { driver, mockUnsafe, clearSqlMocks } = createFakeSql(async (sql: string, _values?: unknown[]) => {
  if (/select[\s\S]*from\s+snapshots/i.test(sql)) {
    return { rows: snapshotRows, rowCount: snapshotRows.length };
  }
  if (/select[\s\S]*from\s+securities/i.test(sql)) {
    return { rows: securityRows, rowCount: securityRows.length };
  }
  if (/select[\s\S]*from\s+accounts/i.test(sql)) {
    return { rows: accountRows, rowCount: accountRows.length };
  }
  // INSERT / UPDATE / upsert and anything else: report one affected row.
  return { rows: [{ ok: true }], rowCount: 1 };
});

mock.module("../../lib/postgres/sql-driver", () => driver);

// `mock.module` is process-global in Bun and `restoreLeaves` only restores the
// driver / `password` leaves, so spread the real module rather than replacing it —
// and put it back in `afterAll` (the post-transaction-routes.test.ts pattern)
// so sibling files sharing the process exercise the real `sendAlarm`.
const realAlarm = { ...(await import("server/lib/alarm")) };

const mockSendAlarm = mock(async (_title: string, _detail: string, _key?: string) => undefined);
mock.module("server/lib/alarm", () => ({ ...realAlarm, sendAlarm: mockSendAlarm }));

const { postHoldingSnapshotRoute } = await import("./post\-holding\-snapshot");

afterAll(() => {
  mock.module("server/lib/alarm", () => realAlarm);
  restoreLeaves();
});

beforeEach(() => {
  // The create path starts a monthly backfill it does not await, so this file
  // cannot await it either. With no API key every month short-circuits before
  // reaching `fetch`, and the chain finishes in microtasks instead of
  // outliving the file and recording its calls against whatever stub the next
  // file installs. Stated here rather than inherited from the ambient env,
  // which a leak from an earlier file can make truthy.
  process.env.POLYGON_API_KEY = "";
  clearSqlMocks();
  mockSendAlarm.mockClear();
  snapshotRows = [];
  securityRows = [];
  accountRows = [];
});

function makeReq(body: unknown, userId: string | undefined = "u-1") {
  return {
    method: "POST",
    path: "/snapshots/holding",
    url: "http://x/api/snapshots/holding",
    headers: {},
    query: {},
    body,
    session: {
      id: "s-1",
      user: userId ? { user_id: userId, username: "test" } : undefined,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof postHoldingSnapshotRoute.execute>[0];
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
  }) as unknown as Parameters<typeof postHoldingSnapshotRoute.execute>[1];

const findCall = (re: RegExp): { sql: string; values: unknown[] } | null => {
  for (const call of mockUnsafe.mock.calls) {
    const sql = call[0] as string;
    if (re.test(sql)) return { sql, values: (call[1] ?? []) as unknown[] };
  }
  return null;
};

// A row shaped to satisfy SecurityModel validation (securitiesTable.query
// wraps each row in the model before searchSecurities maps it to JSON).
const existingSecurityRow = (overrides: Record<string, unknown> = {}) => ({
  security_id: "sec-1",
  ticker_symbol: "VOO",
  name: "Vanguard S&P 500 ETF",
  type: null,
  close_price: null,
  close_price_as_of: null,
  iso_currency_code: "USD",
  unofficial_currency_code: null,
  isin: null,
  cusip: null,
  sedol: null,
  institution_security_id: null,
  institution_id: null,
  proxy_security_id: null,
  is_cash_equivalent: null,
  market_identifier_code: null,
  sector: null,
  industry: null,
  option_contract: null,
  fixed_income: null,
  update_datetime: null,
  raw: null,
  updated: null,
  ...overrides,
});

// `getHoldingSnapshots` (the ownership gate) now reads through
// `snapshotsTable.query`, which hydrates each row into a `SnapshotModel` — its
// typeChecker requires every column present (null is fine, undefined is not),
// so this returns the full row shape.
const holdingSnapshotRow = (overrides: Record<string, unknown> = {}) => ({
  snapshot_id: "snap-1",
  user_id: null,
  snapshot_date: "2024-03-15",
  snapshot_type: "holding",
  account_id: null,
  balances_available: null,
  balances_current: null,
  balances_limit: null,
  balances_iso_currency_code: null,
  security_id: null,
  close_price: null,
  holding_account_id: "acct-1",
  holding_security_id: "sec-1",
  quantity: 10,
  cost_basis: 1000,
  institution_price: 110,
  institution_value: 1100,
  updated: null,
  is_deleted: false,
  ...overrides,
});

// `getAccount` (the create-mode ownership gate) reads through
// `accountsTable.queryOne`, which hydrates the row into an `AccountModel` — its
// typeChecker requires every column present (null is fine, undefined is not).
const accountRow = (overrides: Record<string, unknown> = {}) => ({
  account_id: "acct-9",
  user_id: "u-1",
  item_id: "item-1",
  institution_id: "ins-1",
  name: "Brokerage",
  type: "investment",
  subtype: null,
  balances_available: 0,
  balances_current: 0,
  balances_limit: 0,
  balances_iso_currency_code: "USD",
  custom_name: "",
  hide: false,
  archived: false,
  label_budget_id: null,
  graph_options_use_snapshots: false,
  graph_options_use_holding_snapshots: false,
  graph_options_use_transactions: false,
  raw: null,
  updated: null,
  is_deleted: false,
  ...overrides,
});

describe("post-holding-snapshot update mode", () => {
  test("rejects a snapshot_id the user does not own (ownership gate)", async () => {
    // The by-id lookup finds nothing for this id → cross-user access is
    // denied without touching the write path.
    snapshotRows = [];

    const result = await postHoldingSnapshotRoute.execute(
      makeReq({ snapshot_id: "someone-elses", quantity: 5 }),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not found or access denied/i);
    // No UPDATE should have been issued.
    expect(findCall(/update\s+snapshots/i)).toBeNull();
  });

  test("rejects an empty patch with 'no fields to update'", async () => {
    snapshotRows = [holdingSnapshotRow()];

    const result = await postHoldingSnapshotRoute.execute(
      makeReq({ snapshot_id: "snap-1" }),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/no fields to update/i);
    expect(findCall(/update\s+snapshots/i)).toBeNull();
  });

  test("applies numeric patches (including 0) and re-syncs the holdings row", async () => {
    snapshotRows = [holdingSnapshotRow()];

    const result = await postHoldingSnapshotRoute.execute(
      // quantity: 0 must be applied — the route's `!== undefined` guard
      // distinguishes "field absent" from "field set to zero".
      makeReq({ snapshot_id: "snap-1", quantity: 0, cost_basis: 250 }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(result?.body?.snapshot_id).toBe("snap-1");
    expect(result?.body?.security_id).toBe("sec-1");

    // The UPDATE must carry the patched values and be user-scoped.
    const upd = findCall(/update\s+snapshots/i);
    expect(upd).not.toBeNull();
    expect(upd!.values).toContain(0); // quantity = 0 applied, not dropped
    expect(upd!.values).toContain(250);
    expect(upd!.values).toContain("snap-1");
    expect(upd!.values).toContain("u-1");

    // Both snapshots reads are by-id lookups, not full-list fetches: the
    // ownership check and the post-write re-read each carry the requested
    // id and the caller, and each answers one row.
    const selects = mockUnsafe.mock.calls.filter((call) =>
      /select[\s\S]*from\s+snapshots/i.test(call[0] as string),
    );
    expect(selects).toHaveLength(2);
    for (const call of selects) {
      const values = (call[1] ?? []) as unknown[];
      expect(values).toContain("snap-1");
      expect(values).toContain("u-1");
      // One row, not the whole list — the limit is a bound parameter.
      expect(call[0] as string).toMatch(/LIMIT\s+\$\d+/i);
      expect(values).toContain(1);
    }
  });

  // The date axis the sibling route guards: an unparseable string reaches
  // `toISOString` outside the handler's try, so the client sees a 500 and the
  // global alarm pages.
  test("rejects an unparseable snapshot_date instead of throwing past the try", async () => {
    for (const snapshot_date of ["garbage", "2026-13-45x"]) {
      clearSqlMocks();
      snapshotRows = [holdingSnapshotRow()];

      const result = await postHoldingSnapshotRoute.execute(
        makeReq({ snapshot_id: "snap-1", snapshot_date }),
        fakeRes(),
      );

      expect(result?.status).toBe("failed");
      expect(result?.message).toMatch(/not a valid date/i);
      expect(findCall(/update\s+snapshots/i)).toBeNull();
    }
  });

  test("rejects a non-string snapshot_date instead of dropping it from the patch", async () => {
    for (const snapshot_date of [20260701, { $ne: null }, ["2024-03-15"]]) {
      clearSqlMocks();
      snapshotRows = [holdingSnapshotRow()];

      const result = await postHoldingSnapshotRoute.execute(
        makeReq({ snapshot_id: "snap-1", snapshot_date }),
        fakeRes(),
      );

      expect(result?.status).toBe("failed");
      expect(result?.message).toMatch(/must be a string/i);
      expect(findCall(/update\s+snapshots/i)).toBeNull();
    }
  });

  test("rejects a non-number patch field before any SQL or alarm", async () => {
    // The #776 pattern: the numeric patch fields are validated before the
    // ownership lookup, so a client type error issues no SQL and no alarm.
    // Without the guard the route reaches the snapshots SELECT and then the
    // DECIMAL write, so both assertions discriminate.
    snapshotRows = [holdingSnapshotRow()];
    for (const [field, value] of [
      ["quantity", "abc"],
      ["cost_basis", "abc"],
      ["institution_price", true],
      ["institution_value", "abc"],
    ] as [string, unknown][]) {
      clearSqlMocks();
      mockSendAlarm.mockClear();
      const result = await postHoldingSnapshotRoute.execute(
        makeReq({ snapshot_id: "snap-1", [field]: value }),
        fakeRes(),
      );
      expect(result?.status).toBe("failed");
      expect(result?.message).toBe(`Field ${field} must be a number`);
      expect(mockUnsafe).not.toHaveBeenCalled();
      expect(mockSendAlarm).not.toHaveBeenCalled();
    }
  });

  test("an explicit null patch clears the column instead of failing", async () => {
    // The four numeric columns are nullable, so null is a legitimate
    // "clear this field" edit — the spec says so, the write must agree.
    snapshotRows = [holdingSnapshotRow()];

    const result = await postHoldingSnapshotRoute.execute(
      makeReq({ snapshot_id: "snap-1", quantity: null }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    const upd = findCall(/update\s+snapshots/i);
    expect(upd).not.toBeNull();
    expect(upd!.values).toContain(null);
  });

  test("refuses a patch whose derived institution_value would overflow, writing nothing", async () => {
    // R2 MED, re-sync path: the stored row carries no explicit
    // institution_value, so the re-sync derives it from the patched
    // quantity * institution_price — 1e8 * 1e8 overflows DECIMAL(15, 2)
    // and upsertHoldings would swallow the 22003. The combination is
    // refused before the snapshot write, so neither table is written and
    // the holdings row cannot go stale behind a written snapshot.
    snapshotRows = [
      holdingSnapshotRow({ quantity: 10, institution_price: 110, institution_value: null }),
    ];

    const result = await postHoldingSnapshotRoute.execute(
      makeReq({ snapshot_id: "snap-1", quantity: 1e8, institution_price: 1e8 }),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(result?.message).toBe(
      "Field institution_value must be at most 9999999999999.99",
    );
    expect(findCall(/update\s+snapshots/i)).toBeNull();
    expect(findCall(/insert\s+into\s+holdings/i)).toBeNull();
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  test("an explicit institution_value lets an overflowing patch pair through to the write", async () => {
    // The derivation only runs when the snapshot carries no explicit value
    // — an explicit (spec-bounded) value is stored as given, so the
    // product never reaches the holdings column.
    snapshotRows = [
      holdingSnapshotRow({ quantity: 10, institution_price: 110, institution_value: null }),
    ];

    const result = await postHoldingSnapshotRoute.execute(
      makeReq({
        snapshot_id: "snap-1",
        quantity: 1e8,
        institution_price: 1e8,
        institution_value: 100,
      }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(findCall(/update\s+snapshots/i)).not.toBeNull();
  });

  test("a valid snapshot_date still patches the row", async () => {
    snapshotRows = [holdingSnapshotRow()];

    const result = await postHoldingSnapshotRoute.execute(
      makeReq({ snapshot_id: "snap-1", snapshot_date: "2024-03-15" }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(findCall(/update\s+snapshots/i)!.values).toContain("2024-03-15");
  });
});

describe("post-holding-snapshot create mode", () => {
  test("creates with an existing security and a deterministic snapshot_id", async () => {
    // searchSecurities finds the ticker locally → Polygon is never called.
    securityRows = [existingSecurityRow()]; // found locally → Polygon skipped
    accountRows = [accountRow()];

    const result = await postHoldingSnapshotRoute.execute(
      makeReq({
        account_id: "acct-9",
        ticker_symbol: "voo",
        quantity: 3,
        snapshot_date: "2024-03-15",
      }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(result?.body?.security_id).toBe("sec-1");
    // snapshot_id = `holding-${account_id}-${security_id}-${squashedDate}`.
    const expectedDate = getSquashedDateString(new LocalDate("2024-03-15"));
    expect(result?.body?.snapshot_id).toBe(`holding-acct-9-sec-1-${expectedDate}`);
  });

  test("a security named by id is used as given, without a ticker lookup", async () => {
    securityRows = [existingSecurityRow({ security_id: "sec-mapped" })];
    accountRows = [accountRow()];

    const result = await postHoldingSnapshotRoute.execute(
      makeReq({ account_id: "acct-9", security_id: "sec-mapped", quantity: 3, snapshot_date: "2024-03-15" }),
      fakeRes(),
    );

    const expectedDate = getSquashedDateString(new LocalDate("2024-03-15"));
    expect(result?.body).toMatchObject({ security_id: "sec-mapped", snapshot_id: `holding-acct-9-sec-mapped-${expectedDate}` });
    expect(findCall(/from\s+securities[\s\S]*ticker_symbol/i)).toBeNull();
  });

  test("a security id that doesn't exist is refused", async () => {
    accountRows = [accountRow()];
    const result = await postHoldingSnapshotRoute.execute(
      makeReq({ account_id: "acct-9", security_id: "sec-gone", quantity: 3, snapshot_date: "2024-03-15" }),
      fakeRes(),
    );
    expect(result).toMatchObject({ status: "failed", message: "Security not found." });
    expect(findCall(/^\s*INSERT INTO snapshots/i)).toBeNull();
  });

  test("re-posting the same (account, security, date) reuses the snapshot_id", async () => {
    securityRows = [existingSecurityRow()];
    accountRows = [accountRow()];

    const body = {
      account_id: "acct-9",
      ticker_symbol: "VOO",
      quantity: 3,
      snapshot_date: "2024-03-15",
    };
    const first = await postHoldingSnapshotRoute.execute(makeReq(body), fakeRes());
    const second = await postHoldingSnapshotRoute.execute(makeReq(body), fakeRes());

    // Deterministic id means an in-place upsert, not a duplicate row.
    const expectedDate = getSquashedDateString(new LocalDate("2024-03-15"));
    expect(first?.body?.snapshot_id).toBe(`holding-acct-9-sec-1-${expectedDate}`);
    expect(second?.body?.snapshot_id).toBe(first?.body?.snapshot_id);
  });

  test("rejects an account_id the user does not own and writes nothing", async () => {
    // The victim's account exists, but `getAccount` is user_id-scoped, so an
    // attacker owning zero accounts gets no row back.
    securityRows = [existingSecurityRow()];
    accountRows = [];

    const result = await postHoldingSnapshotRoute.execute(
      makeReq({
        account_id: "victim-account",
        ticker_symbol: "VOO",
        quantity: 999,
        snapshot_date: "2024-03-15",
      }),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not found or access denied/i);
    // Neither table may be written: `snapshot_id` and `holding_id` are both
    // minted from the caller-supplied account_id, so a collision on either is
    // a cross-tenant write.
    expect(findCall(/insert\s+into\s+snapshots/i)).toBeNull();
    expect(findCall(/insert\s+into\s+holdings/i)).toBeNull();
  });

  test("rejects a non-string account_id instead of minting ids from it", async () => {
    securityRows = [existingSecurityRow()];
    accountRows = [accountRow()];

    for (const account_id of [{ $ne: null }, 42, ["acct-9"]]) {
      const result = await postHoldingSnapshotRoute.execute(
        makeReq({ account_id, ticker_symbol: "VOO", quantity: 1 }),
        fakeRes(),
      );
      expect(result?.status).toBe("failed");
      expect(result?.message).toMatch(/account_id/i);
      expect(findCall(/insert\s+into\s+snapshots/i)).toBeNull();
      expect(findCall(/insert\s+into\s+holdings/i)).toBeNull();
    }
  });

  test("the ownership lookup carries the caller's user_id and the requested account_id", async () => {
    securityRows = [existingSecurityRow()];
    accountRows = [];

    await postHoldingSnapshotRoute.execute(
      makeReq({
        account_id: "victim-account",
        ticker_symbol: "VOO",
        quantity: 1,
      }),
      fakeRes(),
    );

    const lookup = findCall(/select[\s\S]*from\s+accounts/i);
    expect(lookup).not.toBeNull();
    expect(lookup!.values).toContain("u-1");
    expect(lookup!.values).toContain("victim-account");
  });

  test("rejects non-number numerics in create mode before any SQL or alarm", async () => {
    // Same #776 shape as the update-mode test: validation runs before the
    // ownership lookup, so a bad quantity (or optional numeric) issues no
    // SQL and no alarm. Without the guard the route reaches the accounts
    // SELECT and then the DECIMAL write.
    securityRows = [existingSecurityRow()];
    accountRows = [accountRow()];
    for (const [field, value] of [
      ["quantity", "abc"],
      ["quantity", true],
      ["cost_basis", "abc"],
      ["institution_price", true],
      ["institution_value", "abc"],
    ] as [string, unknown][]) {
      clearSqlMocks();
      mockSendAlarm.mockClear();
      const result = await postHoldingSnapshotRoute.execute(
        makeReq({ account_id: "acct-9", ticker_symbol: "VOO", quantity: 3, [field]: value }),
        fakeRes(),
      );
      expect(result?.status).toBe("failed");
      expect(result?.message).toBe(`Field ${field} must be a number`);
      expect(mockUnsafe).not.toHaveBeenCalled();
      expect(mockSendAlarm).not.toHaveBeenCalled();
    }
  });

  test("a create with no snapshot_date defaults to today, not to a fixed instant", async () => {
    securityRows = [existingSecurityRow()];
    accountRows = [accountRow()];

    const result = await postHoldingSnapshotRoute.execute(
      makeReq({ account_id: "acct-9", ticker_symbol: "VOO", quantity: 1 }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(result?.body?.snapshot_id).toBe(
      `holding-acct-9-sec-1-${getSquashedDateString(new Date())}`,
    );
  });

  test("a create with an explicit institution_value succeeds when quantity * price overflows", async () => {
    // R2 MED, create path: the explicit value is stored as given, so the
    // 1e8 * 1e8 product never reaches the holdings column — the guard
    // passes and the create succeeds.
    securityRows = [existingSecurityRow()];
    accountRows = [accountRow()];

    const result = await postHoldingSnapshotRoute.execute(
      makeReq({
        account_id: "acct-9",
        ticker_symbol: "VOO",
        quantity: 1e8,
        institution_price: 1e8,
        institution_value: 100,
        snapshot_date: "2024-03-15",
      }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(findCall(/insert\s+into\s+holdings/i)).not.toBeNull();
  });

  test("a create with an under-limit product derives institution_value into the holdings row", async () => {
    // The happy derived path still works: 1e6 * 1e6 fits DECIMAL(15, 2),
    // so the holdings row carries the derived 1e12.
    securityRows = [existingSecurityRow()];
    accountRows = [accountRow()];

    const result = await postHoldingSnapshotRoute.execute(
      makeReq({
        account_id: "acct-9",
        ticker_symbol: "VOO",
        quantity: 1e6,
        institution_price: 1e6,
        snapshot_date: "2024-03-15",
      }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    const holdingsInsert = findCall(/insert\s+into\s+holdings/i);
    expect(holdingsInsert).not.toBeNull();
    expect(holdingsInsert!.values).toContain(1e12);
  });

  test("rejects an unparseable snapshot_date instead of minting a NaN id", async () => {
    for (const snapshot_date of ["garbage", "2026-13-45x"]) {
      clearSqlMocks();
      securityRows = [existingSecurityRow()];
      accountRows = [accountRow()];

      const result = await postHoldingSnapshotRoute.execute(
        makeReq({ account_id: "acct-9", ticker_symbol: "VOO", quantity: 1, snapshot_date }),
        fakeRes(),
      );

      expect(result?.status).toBe("failed");
      expect(result?.message).toMatch(/not a valid date/i);
      expect(findCall(/insert\s+into\s+snapshots/i)).toBeNull();
      expect(findCall(/insert\s+into\s+holdings/i)).toBeNull();
    }
  });

  // A number is epoch-milliseconds to `LocalDate`, so an unchecked cast writes
  // a real 1970 snapshot into the user's graph rather than failing.
  test("rejects a non-string snapshot_date instead of reading it as epoch ms", async () => {
    for (const snapshot_date of [20260701, { $ne: null }, ["2024-03-15"]]) {
      clearSqlMocks();
      securityRows = [existingSecurityRow()];
      accountRows = [accountRow()];

      const result = await postHoldingSnapshotRoute.execute(
        makeReq({ account_id: "acct-9", ticker_symbol: "VOO", quantity: 1, snapshot_date }),
        fakeRes(),
      );

      expect(result?.status).toBe("failed");
      expect(result?.message).toMatch(/must be a string/i);
      expect(result?.body?.snapshot_id).toBeUndefined();
      expect(findCall(/insert\s+into\s+snapshots/i)).toBeNull();
      expect(findCall(/insert\s+into\s+holdings/i)).toBeNull();
    }
  });

  test("a malformed snapshot_date fails before the ownership round trip", async () => {
    securityRows = [existingSecurityRow()];
    accountRows = [accountRow()];

    await postHoldingSnapshotRoute.execute(
      makeReq({ account_id: "acct-9", ticker_symbol: "VOO", quantity: 1, snapshot_date: "garbage" }),
      fakeRes(),
    );

    expect(findCall(/select[\s\S]*from\s+accounts/i)).toBeNull();
  });
});
