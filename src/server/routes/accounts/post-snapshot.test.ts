import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import { getSquashedDateString } from "common";

const issued: { sql: string; values?: unknown[] }[] = [];
let ownedAccountRows: unknown[] = [];

const { driver } = createFakeSql(async (sql: string, values?: unknown[]) => {
  issued.push({ sql, values });
  if (/FROM\s+accounts/i.test(sql)) {
    return { rows: ownedAccountRows, rowCount: ownedAccountRows.length };
  }
  return { rows: [{ snapshot_id: "acct-A-20260701" }], rowCount: 1 };
});

mock.module("../../lib/postgres/sql-driver", () => driver);

// `mock.module` is process-global in Bun and `restoreLeaves` only restores the
// driver / `password` leaves, so spread the real module rather than replacing it —
// and put it back in `afterAll` (the post-transaction-routes.test.ts pattern)
// so sibling files sharing the process exercise the real `sendAlarm`.
const realAlarm = { ...(await import("server/lib/alarm")) };

const mockSendAlarm = mock(async (_title: string, _detail: string, _key?: string) => undefined);
mock.module("server/lib/alarm", () => ({ ...realAlarm, sendAlarm: mockSendAlarm }));

const { postSnapshotRoute } = await import("./post-snapshot");

afterAll(() => {
  mock.module("server/lib/alarm", () => realAlarm);
  restoreLeaves();
});

const ACCOUNT_ROW = {
  account_id: "acct-A",
  user_id: "victim",
  item_id: "item-1",
  institution_id: "ins-1",
  name: "Checking",
  type: "depository",
  subtype: "checking",
  balances_available: null,
  balances_current: 0,
  balances_limit: null,
  balances_iso_currency_code: "USD",
  custom_name: null,
  hide: false,
  archived: false,
  label_budget_id: null,
  graph_options_use_snapshots: true,
  graph_options_use_holding_snapshots: true,
  graph_options_use_transactions: true,
  raw: null,
  updated: null,
  is_deleted: false,
};

const makeReq = (body: unknown, userId?: string) =>
  ({
    method: "POST",
    path: "/snapshot",
    url: "http://x/api/snapshot",
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
  }) as unknown as Parameters<typeof postSnapshotRoute.execute>[0];

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
  }) as unknown as Parameters<typeof postSnapshotRoute.execute>[1];

const victimsAccount = {
  account: {
    account_id: "acct-A",
    balances: { current: 1, available: 1, iso_currency_code: "USD" },
  },
  snapshot: { date: "2026-07-01" },
};

beforeEach(() => {
  issued.length = 0;
  ownedAccountRows = [];
  mockSendAlarm.mockClear();
});

describe("post-snapshot ownership", () => {
  test("rejects an account the caller does not own", async () => {
    const result = await postSnapshotRoute.execute(makeReq(victimsAccount, "attacker"), fakeRes());
    expect(result!.status).toBe("failed");
    expect(result!.message).toMatch(/not found or access denied/i);
    expect(issued.some((q) => /INSERT INTO snapshots/i.test(q.sql))).toBe(false);
  });

  test("scopes the ownership lookup to the caller", async () => {
    await postSnapshotRoute.execute(makeReq(victimsAccount, "attacker"), fakeRes());
    const lookup = issued.find((q) => /FROM\s+accounts/i.test(q.sql));
    expect(lookup).toBeTruthy();
    expect(lookup!.values).toContain("attacker");
    expect(lookup!.values).toContain("acct-A");
  });

  test("writes the snapshot when the caller owns the account", async () => {
    ownedAccountRows = [{ ...ACCOUNT_ROW, user_id: "owner" }];
    const result = await postSnapshotRoute.execute(makeReq(victimsAccount, "owner"), fakeRes());
    expect(result!.status).toBe("success");
    expect(issued.some((q) => /INSERT INTO snapshots/i.test(q.sql))).toBe(true);
  });
});

describe("post-snapshot body validation", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await postSnapshotRoute.execute(makeReq(victimsAccount), fakeRes());
    expect(result!.status).toBe("failed");
    expect(result!.message).toMatch(/not authenticated/i);
  });

  test("rejects a body with no account instead of throwing", async () => {
    const result = await postSnapshotRoute.execute(
      makeReq({ snapshot: { date: "2026-07-01" } }, "owner"),
      fakeRes(),
    );
    expect(result!.status).toBe("failed");
    expect(result!.message).toMatch(/account_id/i);
  });

  test("rejects a non-string account_id instead of minting a snapshot id from it", async () => {
    const result = await postSnapshotRoute.execute(
      makeReq({ account: { account_id: { $ne: null } }, snapshot: {} }, "owner"),
      fakeRes(),
    );
    expect(result!.status).toBe("failed");
    expect(result!.message).toMatch(/account_id/i);
  });

  // `snapshot` is the sibling axis of `account`: both are caller-supplied
  // objects the route dereferences before any write.
  test("rejects a snapshot that is not a plain object", async () => {
    ownedAccountRows = [{ ...ACCOUNT_ROW, user_id: "owner" }];
    for (const snapshot of [[], [{ date: "2026-07-01" }], "2026-07-01", 7]) {
      issued.length = 0;
      const result = await postSnapshotRoute.execute(
        makeReq({ account: victimsAccount.account, snapshot }, "owner"),
        fakeRes(),
      );
      expect(result!.status).toBe("failed");
      expect(result!.message).toMatch(/snapshot data/i);
      expect(issued.some((q) => /INSERT INTO snapshots/i.test(q.sql))).toBe(false);
    }
  });

  test("rejects an explicitly null snapshot instead of throwing", async () => {
    ownedAccountRows = [{ ...ACCOUNT_ROW, user_id: "owner" }];
    const result = await postSnapshotRoute.execute(
      makeReq({ account: victimsAccount.account, snapshot: null }, "owner"),
      fakeRes(),
    );
    expect(result!.status).toBe("failed");
    expect(result!.message).toMatch(/snapshot data/i);
    expect(issued.some((q) => /INSERT INTO snapshots/i.test(q.sql))).toBe(false);
  });

  test("rejects an unparseable snapshot.date instead of minting a NaN id", async () => {
    ownedAccountRows = [{ ...ACCOUNT_ROW, user_id: "owner" }];
    for (const date of ["garbage", "2026-13-45x"]) {
      issued.length = 0;
      const result = await postSnapshotRoute.execute(
        makeReq({ account: victimsAccount.account, snapshot: { date } }, "owner"),
        fakeRes(),
      );
      expect(result!.status).toBe("failed");
      expect(result!.message).toMatch(/not a valid date/i);
      expect(issued.some((q) => /INSERT INTO snapshots/i.test(q.sql))).toBe(false);
    }
  });

  test("rejects a non-string snapshot.date", async () => {
    ownedAccountRows = [{ ...ACCOUNT_ROW, user_id: "owner" }];
    const result = await postSnapshotRoute.execute(
      makeReq({ account: victimsAccount.account, snapshot: { date: 20260701 } }, "owner"),
      fakeRes(),
    );
    expect(result!.status).toBe("failed");
    expect(result!.message).toMatch(/must be a string/i);
  });

  test("rejects a non-number balance before any SQL or alarm", async () => {
    // The #776 pattern: the balance fields are validated before the
    // ownership lookup, so a client type error issues no SQL and no alarm.
    // Without the guard the route reaches the accounts SELECT and then the
    // DECIMAL write, so both assertions discriminate.
    ownedAccountRows = [{ ...ACCOUNT_ROW, user_id: "owner" }];
    for (const [field, value] of [
      ["current", "abc"],
      ["available", true],
      ["limit", "abc"],
      ["iso_currency_code", 42],
    ] as [string, unknown][]) {
      issued.length = 0;
      mockSendAlarm.mockClear();
      const result = await postSnapshotRoute.execute(
        makeReq(
          { account: { account_id: "acct-A", balances: { [field]: value } }, snapshot: {} },
          "owner",
        ),
        fakeRes(),
      );
      expect(result!.status).toBe("failed");
      expect(result!.message).toBe(
        field === "iso_currency_code"
          ? "Field account.balances.iso_currency_code must be a string"
          : `Field account.balances.${field} must be a number`,
      );
      expect(issued).toHaveLength(0);
      expect(mockSendAlarm).not.toHaveBeenCalled();
    }
  });

  test("refuses an over-limit balance before any SQL or alarm", async () => {
    // The #880 follow-up: the DECIMAL(15, 2) / VARCHAR(10) bounds now live
    // on this spec too, so an overflowing balance is a `failed` answer
    // naming the limit, not a 22003 at the write. Without the bound the
    // route reaches the accounts SELECT and then the write, so both
    // assertions discriminate.
    ownedAccountRows = [{ ...ACCOUNT_ROW, user_id: "owner" }];
    for (const [field, value, message] of [
      ["current", 1e13, "Field account.balances.current must be at most 9999999999999.99 in magnitude"],
      ["available", -1e13, "Field account.balances.available must be at most 9999999999999.99 in magnitude"],
      ["limit", 1e13, "Field account.balances.limit must be at most 9999999999999.99 in magnitude"],
      ["iso_currency_code", "US Dollars!", "Field account.balances.iso_currency_code must be at most 10 characters"],
    ] as [string, unknown, string][]) {
      issued.length = 0;
      mockSendAlarm.mockClear();
      const result = await postSnapshotRoute.execute(
        makeReq(
          { account: { account_id: "acct-A", balances: { [field]: value } }, snapshot: {} },
          "owner",
        ),
        fakeRes(),
      );
      expect(result!.status).toBe("failed");
      expect(result!.message).toBe(message);
      expect(issued).toHaveLength(0);
      expect(mockSendAlarm).not.toHaveBeenCalled();
    }
  });

  test("accepts a balance exactly at the column bound and writes", async () => {
    // The bound is the column's exact one, not a rounded-down guard: the
    // at-limit value must reach the write.
    ownedAccountRows = [{ ...ACCOUNT_ROW, user_id: "owner" }];
    const result = await postSnapshotRoute.execute(
      makeReq(
        {
          account: {
            account_id: "acct-A",
            balances: { current: 9999999999999.99, iso_currency_code: "0123456789" },
          },
          snapshot: { date: "2026-07-01" },
        },
        "owner",
      ),
      fakeRes(),
    );
    expect(result!.status).toBe("success");
    expect(issued.some((q) => /INSERT INTO snapshots/i.test(q.sql))).toBe(true);
  });

  test("an explicit null balance clears the column instead of failing", async () => {
    // The three balance columns are nullable, so null is a legitimate
    // "clear this field" value — the spec says so, the write must agree.
    ownedAccountRows = [{ ...ACCOUNT_ROW, user_id: "owner" }];
    const result = await postSnapshotRoute.execute(
      makeReq(
        { account: { account_id: "acct-A", balances: { current: null } }, snapshot: { date: "2026-07-01" } },
        "owner",
      ),
      fakeRes(),
    );
    expect(result!.status).toBe("success");
    expect(issued.some((q) => /INSERT INTO snapshots/i.test(q.sql))).toBe(true);
  });

  test("a snapshot with no date still defaults to today and writes", async () => {
    ownedAccountRows = [{ ...ACCOUNT_ROW, user_id: "owner" }];
    const result = await postSnapshotRoute.execute(
      makeReq({ account: victimsAccount.account, snapshot: {} }, "owner"),
      fakeRes(),
    );
    expect(result!.status).toBe("success");
    expect(issued.some((q) => /INSERT INTO snapshots/i.test(q.sql))).toBe(true);
    // Naming "today" without asserting it lets the default drift to any fixed
    // instant — including the epoch, which is the 1970 row the input guards
    // above exist to prevent.
    expect(result!.body!.snapshot_id).toBe(`acct-A-${getSquashedDateString(new Date())}`);
  });
});
