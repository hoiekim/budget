import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves, updateColumnsOf } from "test-helpers";

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

const { deleteHoldings, searchHoldingsByAccountId, upsertHoldings } = await import("./holdings");

afterAll(restoreLeaves);

const mockUser = { user_id: "usr-1", username: "tester" } as {
  user_id: string;
  username: string;
};

beforeEach(() => {
  mockQuery.mockClear();
  mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
});

describe("deleteHoldings — terminator-only model", () => {
  // The sync path writes a `quantity = 0` terminator snapshot for every
  // removed holding BEFORE calling deleteHoldings (see
  // compute-tools/create-snapshots.ts). That terminator is the deletion signal
  // historical readers consume — deleteHoldings must NOT soft-delete snapshot
  // rows on top: doing so wipes every holding's snapshot history for the
  // entire account when a single position is removed.

  test("only the holdings table is updated — snapshots are untouched", async () => {
    await deleteHoldings(mockUser, ["acc-1-sec-a", "acc-1-sec-b"]);
    const updateCalls = mockQuery.mock.calls.filter(([sql]) =>
      String(sql).toUpperCase().startsWith("UPDATE "),
    );
    expect(updateCalls.length).toBeGreaterThan(0);
    for (const [sql] of updateCalls) {
      expect(String(sql)).toContain("UPDATE holdings");
      expect(String(sql)).not.toContain("snapshots");
    }
  });

  test("empty input is a no-op (no SQL emitted)", async () => {
    await deleteHoldings(mockUser, []);
    expect(mockQuery.mock.calls.length).toBe(0);
  });

  test("returns the deleted-rowCount from the holdings UPDATE", async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [], rowCount: 3 }));
    const result = await deleteHoldings(mockUser, ["acc-1-sec-a", "acc-1-sec-b", "acc-1-sec-c"]);
    expect(result).toEqual({ deleted: 3 });
  });

  test("user_id is part of the WHERE clause (caller is scoped)", async () => {
    await deleteHoldings(mockUser, ["acc-1-sec-a"]);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("user_id");
    expect(values).toContain("usr-1");
  });
});

describe("searchHoldingsByAccountId — single batched query", () => {
  // Previously this looped `holdingsTable.query` once per account_id — an N+1
  // on the Plaid/SimpleFin sync path (one round-trip per account of an item,
  // per user, per sync). Lock in that N accounts now resolve in ONE
  // `account_id IN (...)` query so the cost is O(1) round-trips, not O(N).

  test("N accounts issue exactly one SELECT with an IN clause", async () => {
    await searchHoldingsByAccountId(mockUser, ["acc-1", "acc-2", "acc-3"]);
    const selectCalls = mockQuery.mock.calls.filter(([sql]) =>
      String(sql).toUpperCase().includes("SELECT"),
    );
    expect(selectCalls.length).toBe(1);
    const [sql, values] = selectCalls[0];
    expect(String(sql)).toContain("account_id IN (");
    expect(values).toEqual(expect.arrayContaining(["usr-1", "acc-1", "acc-2", "acc-3"]));
  });

  test("empty input is a no-op (no SQL emitted)", async () => {
    await searchHoldingsByAccountId(mockUser, []);
    expect(mockQuery.mock.calls.length).toBe(0);
  });

  test("query is scoped by user_id", async () => {
    await searchHoldingsByAccountId(mockUser, ["acc-1"]);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("user_id = $1");
    expect(values).toContain("usr-1");
  });
});

describe("upsertHoldings conflict", () => {
  const upsertOne = async () => {
    await upsertHoldings(mockUser, [
      {
        holding_id: "acct-A-sec-1",
        account_id: "acct-A",
        security_id: "sec-1",
        quantity: 999,
        cost_basis: 1,
        institution_price: 1,
        institution_price_as_of: "2026-07-01",
        institution_value: 999,
        iso_currency_code: "USD",
        unofficial_currency_code: null,
      },
    ]);
    return mockQuery.mock.calls[0][0] as string;
  };

  test("never reassigns the row owner or the account", async () => {
    const columns = updateColumnsOf(await upsertOne());
    expect(columns.length).toBeGreaterThan(0);
    expect(columns).not.toContain("user_id");
    expect(columns).not.toContain("account_id");
    expect(columns).not.toContain("holding_id");
  });

  test("still rewrites the position", async () => {
    const columns = updateColumnsOf(await upsertOne());
    for (const column of [
      "security_id",
      "institution_price",
      "institution_price_as_of",
      "institution_value",
      "cost_basis",
      "quantity",
      "iso_currency_code",
    ]) {
      expect(columns).toContain(column);
    }
  });

  test("inserts the owner on a first write", async () => {
    const sql = await upsertOne();
    expect(sql.split("DO UPDATE SET")[0]).toContain("user_id");
  });

  test("leaves a column the caller omitted alone rather than nulling it", async () => {
    // `institution_price_as_of` is optional on Plaid's holding payload, so
    // `HoldingModel.fromJSON` leaves it undefined and it never reaches the
    // INSERT column list. A SET entry for it would resolve `EXCLUDED` to the
    // column default and wipe the stored date.
    await upsertHoldings(mockUser, [
      {
        holding_id: "acct-A-sec-1",
        account_id: "acct-A",
        security_id: "sec-1",
        quantity: 999,
      } as never,
    ]);
    const columns = updateColumnsOf(mockQuery.mock.calls[0][0] as string);
    expect(columns).toContain("quantity");
    expect(columns).not.toContain("institution_price_as_of");
    expect(columns).not.toContain("cost_basis");
  });
});
