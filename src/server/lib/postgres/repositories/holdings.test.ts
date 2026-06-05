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

const { deleteHoldings } = await import("./holdings");

afterAll(restoreLeaves);

const mockUser = { user_id: "usr-1", username: "tester" } as {
  user_id: string;
  username: string;
};

beforeEach(() => {
  mockQuery.mockClear();
  mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
});

describe("deleteHoldings — terminator-only model (#471)", () => {
  // The sync path writes a `quantity = 0` terminator snapshot for every
  // removed holding BEFORE calling deleteHoldings (see
  // compute-tools/create-snapshots.ts). That terminator is the
  // deletion signal historical readers consume — there's no need (and
  // it's actively unsafe) for deleteHoldings to soft-delete snapshot
  // rows on top.
  //
  // The previous implementation soft-deleted snapshots filtered on
  // `holding_account_id` alone, which wiped EVERY holding's snapshot
  // history for the entire account whenever a single position was
  // removed (#471). Lock the new contract in: deleteHoldings only
  // touches the `holdings` table.

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
