import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import { ItemProvider } from "common";

// `POST /api/account` serves both the create and the edit path. A FakePool
// intercepts pg so the statement the route actually issues can be asserted:
// which of INSERT / UPDATE runs decides whether a brand-new manual account is
// persisted at all, and a repo unit test (which writes what it is told) cannot
// see that choice.

type Row = Record<string, unknown>;

/**
 * Re-`mockImplementation`-ing a Bun mock inside a test does not reliably
 * replace the module-level default, so the default implementation reads this
 * mutable fixture instead.
 */
const db = {
  item: null as Row | null,
  insertReturns: [] as Row[],
  insertError: null as Error | null,
  updateReturns: [] as Row[],
  updateError: null as Error | null,
};

const mockQuery = mock(async (sql: string, _values?: unknown[]) => {
  const rows = (() => {
    if (/^\s*SELECT\b[\s\S]*\bFROM\s+items\b/i.test(sql)) {
      return db.item ? [db.item] : [];
    }
    if (/^\s*INSERT\s+INTO\s+accounts\b/i.test(sql)) {
      if (db.insertError) throw db.insertError;
      return db.insertReturns;
    }
    if (/^\s*UPDATE\s+accounts\b/i.test(sql)) {
      if (db.updateError) throw db.updateError;
      return db.updateReturns;
    }
    return [];
  })();
  return { rows: rows as unknown[], rowCount: rows.length as number | null };
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

const { postAccountRoute } = await import("./post-account");

afterAll(restoreLeaves);

beforeEach(() => {
  // Clear the call log but keep the fixture-driven implementation.
  mockQuery.mockClear();
  db.item = null;
  db.insertReturns = [];
  db.insertError = null;
  db.updateReturns = [];
  db.updateError = null;
});

/** Full row — `Table.queryOne` hydrates an ItemModel, which validates every column. */
const makeItemRow = (overrides: Row = {}): Row => ({
  item_id: "item-manual",
  user_id: "u-1",
  access_token: "no_access_token",
  institution_id: null,
  available_products: [],
  cursor: null,
  status: "ok",
  provider: ItemProvider.MANUAL,
  status_reason: null,
  last_sync_status: null,
  last_sync_at: null,
  last_sync_error: null,
  raw: null,
  updated: "2026-08-01T00:00:00Z",
  is_deleted: false,
  ...overrides,
});

const newAccountBody = {
  account_id: "acc-new",
  item_id: "item-manual",
  institution_id: "Unknown",
  name: "Unknown",
};

function makeReq(body: unknown, userId?: string) {
  return {
    method: "POST",
    path: "/account",
    url: "http://x/api/account",
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
  } as unknown as Parameters<typeof postAccountRoute.execute>[0];
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
  }) as unknown as Parameters<typeof postAccountRoute.execute>[1];

/** Find the first statement in the call log matching `re`. */
const findStatement = (re: RegExp): { sql: string; values: unknown[] } | null => {
  for (const call of mockQuery.mock.calls) {
    const sql = call[0] as string;
    if (re.test(sql)) return { sql, values: (call[1] ?? []) as unknown[] };
  }
  return null;
};

const INSERT_ACCOUNTS = /^\s*INSERT\s+INTO\s+accounts\b/i;
const UPDATE_ACCOUNTS = /^\s*UPDATE\s+accounts\b/i;

describe("post-account validation", () => {
  test("rejects unauthenticated requests", async () => {
    const result = await postAccountRoute.execute(makeReq(newAccountBody), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not authenticated/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects a non-object body", async () => {
    const result = await postAccountRoute.execute(makeReq("not-an-object", "u-1"), fakeRes());
    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects a missing account_id", async () => {
    const result = await postAccountRoute.execute(makeReq({ item_id: "item-manual" }, "u-1"), fakeRes());
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/account_id/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("post-account create path", () => {
  test("inserts a row for an account_id that does not exist yet", async () => {
    db.item = makeItemRow();
    db.insertReturns = [{ account_id: "acc-new" }];

    const result = await postAccountRoute.execute(makeReq(newAccountBody, "u-1"), fakeRes());

    expect(result?.status).toBe("success");
    expect(result?.body?.account_id).toBe("acc-new");

    const insert = findStatement(INSERT_ACCOUNTS);
    expect(insert).not.toBeNull();
    expect(insert!.values).toContain("acc-new");
    expect(insert!.values).toContain("u-1");
    expect(insert!.values).toContain("item-manual");

    // The create path is reached by the UPDATE matching nothing, not by the
    // body carrying an item_id — so the UPDATE runs first and precedes it.
    const update = findStatement(UPDATE_ACCOUNTS);
    expect(update).not.toBeNull();
    expect(mockQuery.mock.calls.findIndex((c) => UPDATE_ACCOUNTS.test(c[0] as string))).toBeLessThan(
      mockQuery.mock.calls.findIndex((c) => INSERT_ACCOUNTS.test(c[0] as string)),
    );
  });

  test("treats a body carrying item_id as an edit when the row exists", async () => {
    db.item = makeItemRow();
    db.updateReturns = [{ account_id: "acc-1" }];

    // Nothing stops a client from posting item_id on an edit. Classifying by
    // body shape would send this to INSERT, hit the primary key, and report
    // "Account already exists." for a rename that should have succeeded.
    const result = await postAccountRoute.execute(
      makeReq({ account_id: "acc-1", item_id: "item-manual", custom_name: "Renamed" }, "u-1"),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    expect(result?.body?.account_id).toBe("acc-1");
    expect(findStatement(INSERT_ACCOUNTS)).toBeNull();
  });

  test("refuses to move an existing account onto an item the user does not own", async () => {
    db.item = null;
    db.updateReturns = [{ account_id: "acc-1" }];

    // account_id is the user's, so the UPDATE would match. item_id has no
    // foreign key, so writing it unchecked would reparent the account onto
    // someone else's item.
    const result = await postAccountRoute.execute(
      makeReq({ account_id: "acc-1", item_id: "item-somebody-else" }, "u-1"),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/item not found/i);
    expect(findStatement(UPDATE_ACCOUNTS)).toBeNull();
  });

  test("refuses to move an existing account onto a Plaid item", async () => {
    db.item = makeItemRow({ item_id: "item-plaid", provider: ItemProvider.PLAID });
    db.updateReturns = [{ account_id: "acc-1" }];

    const result = await postAccountRoute.execute(
      makeReq({ account_id: "acc-1", item_id: "item-plaid" }, "u-1"),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not a manual account/i);
    expect(findStatement(UPDATE_ACCOUNTS)).toBeNull();
  });

  test("does not resurrect a soft-deleted row on the way to the insert", async () => {
    db.item = makeItemRow();
    db.insertError = Object.assign(new Error("duplicate key"), { code: "23505" });

    const result = await postAccountRoute.execute(makeReq(newAccountBody, "u-1"), fakeRes());

    // A soft-deleted row keeps its primary key. If the UPDATE matched it, the
    // route would answer success for a row no read can see.
    const update = findStatement(UPDATE_ACCOUNTS);
    expect(update!.sql).toContain("is_deleted");
    expect(result?.message).toBe("Account already exists.");
  });

  test("reports failure — not success — when the insert writes no row", async () => {
    db.item = makeItemRow();
    db.insertReturns = [];

    const result = await postAccountRoute.execute(makeReq(newAccountBody, "u-1"), fakeRes());

    expect(result?.status).toBe("error");
    expect(result?.message).toBe("Internal server error");
  });

  test("rejects a create against an item the user does not own", async () => {
    db.item = null;

    const result = await postAccountRoute.execute(makeReq(newAccountBody, "u-1"), fakeRes());

    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/item not found/i);
    expect(findStatement(INSERT_ACCOUNTS)).toBeNull();
  });

  test("rejects a create against a non-manual item", async () => {
    db.item = makeItemRow({ item_id: "item-plaid", provider: ItemProvider.PLAID });

    const result = await postAccountRoute.execute(
      makeReq({ ...newAccountBody, item_id: "item-plaid" }, "u-1"),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/not a manual account/i);
    expect(findStatement(INSERT_ACCOUNTS)).toBeNull();
  });

  test("reports a conflict, not a fault, when the id is already taken", async () => {
    db.item = makeItemRow();
    db.insertError = Object.assign(new Error("duplicate key"), { code: "23505" });

    const result = await postAccountRoute.execute(makeReq(newAccountBody, "u-1"), fakeRes());

    // A soft-deleted row keeps its primary key, so re-creating that id is a
    // client error. Escalating to a 500 would fire the global-cooldown alarm.
    expect(result?.status).toBe("failed");
    expect(result?.message).toBe("Account already exists.");
  });

  test("rejects a create with no institution_id — the column is NOT NULL", async () => {
    db.item = makeItemRow();
    const { institution_id: _institution_id, ...withoutInstitutionId } = newAccountBody;

    const result = await postAccountRoute.execute(makeReq(withoutInstitutionId, "u-1"), fakeRes());

    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/institution_id/i);
    expect(findStatement(INSERT_ACCOUNTS)).toBeNull();
  });

  test("scopes the ownership lookup to the requesting user", async () => {
    db.item = makeItemRow();
    db.insertReturns = [{ account_id: "acc-new" }];

    await postAccountRoute.execute(makeReq(newAccountBody, "u-1"), fakeRes());

    const itemLookup = findStatement(/^\s*SELECT\b[\s\S]*\bFROM\s+items\b/i);
    expect(itemLookup).not.toBeNull();
    expect(itemLookup!.values).toContain("u-1");
    expect(itemLookup!.values).toContain("item-manual");
  });
});

describe("post-account update path", () => {
  const editBody = { account_id: "acc-1", custom_name: "Renamed" };

  test("updates an existing account and never inserts", async () => {
    db.updateReturns = [{ account_id: "acc-1" }];

    const result = await postAccountRoute.execute(makeReq(editBody, "u-1"), fakeRes());

    expect(result?.status).toBe("success");
    expect(result?.body?.account_id).toBe("acc-1");

    const update = findStatement(UPDATE_ACCOUNTS);
    expect(update).not.toBeNull();
    expect(update!.values).toContain("Renamed");
    expect(update!.values).toContain("u-1");
    expect(findStatement(INSERT_ACCOUNTS)).toBeNull();
  });

  test("costs exactly one statement — no existence probe on the hot edit path", async () => {
    db.updateReturns = [{ account_id: "acc-1" }];

    await postAccountRoute.execute(makeReq(editBody, "u-1"), fakeRes());

    expect(mockQuery.mock.calls).toHaveLength(1);
    expect(findStatement(/^\s*SELECT\b[\s\S]*\bFROM\s+items\b/i)).toBeNull();
  });

  test("reports Account not found when the update matches no row", async () => {
    db.updateReturns = [];

    const result = await postAccountRoute.execute(makeReq(editBody, "u-1"), fakeRes());

    // An edit body carries no item_id, so a vanished row must not be reported
    // as a missing-item_id validation error.
    expect(result?.status).toBe("failed");
    expect(result?.message).toBe("Account not found.");
  });

  test("surfaces a DB fault on the edit path as an error", async () => {
    db.updateError = new Error("db down");

    const result = await postAccountRoute.execute(makeReq(editBody, "u-1"), fakeRes());

    expect(result?.status).toBe("error");
    expect(result?.message).toBe("Internal server error");
  });
});
