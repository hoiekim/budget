// Success / side-effect coverage for POST /snapshots/holding (#359). The
// sibling `post-holding-snapshot.test.ts` (from #427) pins the cheap pre-DB
// validation guards; this file drives the two real modes (update + create)
// through a SQL-routing fake `pg` Pool so the ownership gate, the re-sync
// chain, the deterministic snapshot_id, and the no-API-key branch are
// actually exercised — not just the early returns.
//
// Routing rather than a per-call queue keeps the test robust to the extra
// writes (upsert/update) and the fire-and-forget backfill the route emits:
// only the two SELECTs are scripted (snapshots → holding rows, securities →
// security rows); everything else falls through to an empty/ok result.
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import { getSquashedDateString, LocalDate } from "common";

let snapshotRows: Record<string, unknown>[] = [];
let securityRows: Record<string, unknown>[] = [];

const mockQuery = mock(async (sql: string, _values?: unknown[]) => {
  if (/select[\s\S]*from\s+snapshots/i.test(sql)) {
    return { rows: snapshotRows, rowCount: snapshotRows.length };
  }
  if (/select[\s\S]*from\s+securities/i.test(sql)) {
    return { rows: securityRows, rowCount: securityRows.length };
  }
  // INSERT / UPDATE / upsert and anything else: report one affected row.
  return { rows: [{ ok: true }], rowCount: 1 };
});

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

const { postHoldingSnapshotRoute } = await import("./post\-holding\-snapshot");

afterAll(restoreLeaves);

beforeEach(() => {
  mockQuery.mockClear();
  snapshotRows = [];
  securityRows = [];
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
  for (const call of mockQuery.mock.calls) {
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

const holdingSnapshotRow = (overrides: Record<string, unknown> = {}) => ({
  snapshot_id: "snap-1",
  snapshot_date: "2024-03-15",
  holding_account_id: "acct-1",
  holding_security_id: "sec-1",
  quantity: 10,
  cost_basis: 1000,
  institution_price: 110,
  institution_value: 1100,
  ...overrides,
});

describe("post-holding-snapshot update mode", () => {
  test("rejects a snapshot_id the user does not own (ownership gate)", async () => {
    // getHoldingSnapshots returns the user's snapshots; the requested id is
    // absent → cross-user access is denied without touching the write path.
    snapshotRows = [holdingSnapshotRow({ snapshot_id: "owned-by-me" })];

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
  });
});

describe("post-holding-snapshot create mode", () => {
  test("creates with an existing security and a deterministic snapshot_id", async () => {
    // searchSecurities finds the ticker locally → Polygon is never called.
    securityRows = [existingSecurityRow()]; // found locally → Polygon skipped

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

  test("re-posting the same (account, security, date) reuses the snapshot_id", async () => {
    securityRows = [existingSecurityRow()];

    const body = {
      account_id: "acct-9",
      ticker_symbol: "VOO",
      quantity: 3,
      snapshot_date: "2024-03-15",
    };
    const first = await postHoldingSnapshotRoute.execute(makeReq(body), fakeRes());
    const second = await postHoldingSnapshotRoute.execute(makeReq(body), fakeRes());

    // Deterministic id means an in-place upsert, not a duplicate row.
    expect(second?.body?.snapshot_id).toBe(first?.body?.snapshot_id);
  });
});
