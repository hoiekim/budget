import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

type Row = Record<string, unknown>;

const db = {
  insertReturns: [] as Row[],
  /** Each existing budget's owner, by id. */
  parents: new Map<string, string>(),
};

const mockQuery = mock(async (sql: string, values: unknown[] = []) => {
  // The parent lookup answers like its WHERE: by id, and by owner only when the query filters on one.
  const rows = /^\s*INSERT\s+INTO\s+sections\b/i.test(sql)
    ? db.insertReturns
    : /FROM\s+budgets\b/i.test(sql)
      ? [...db.parents]
          .filter(([id, owner]) => values.includes(id) && (!/\buser_id\s*=/i.test(sql) || values.includes(owner)))
          .map(([id, owner]) => ({
            budget_id: id,
            user_id: owner, iso_currency_code: "USD",
            name: "parent",
            roll_over: false,
            roll_over_start_date: null,
            capacities: [],
            updated: "2026-10-01T00:00:00.000Z",
            is_deleted: false,
          }))
      : [];
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

const { getNewSectionRoute } = await import("./get-new-section");

afterAll(() => {
  restoreLeaves();
});

beforeEach(() => {
  mockQuery.mockClear();
  db.insertReturns = [];
  db.parents = new Map([[BUDGET_ID, USER_ID]]);
});

const USER_ID = "11111111-1111-1111-1111-111111111111";
const BUDGET_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const SECTION_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

const makeReq = (
  user?: { user_id: string; username: string },
  query: Record<string, unknown> = { parent: BUDGET_ID },
) =>
  ({
    method: "GET",
    path: "/new-section",
    url: "http://x/api/new-section",
    headers: {},
    query,
    body: undefined,
    session: {
      id: "s-1",
      user,
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  }) as unknown as Parameters<typeof getNewSectionRoute.execute>[0];

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
  }) as unknown as Parameters<typeof getNewSectionRoute.execute>[1];

const CAPACITY_ID = "9c1d3a44-2b6e-4f10-8f7a-1d5c2e6b0a93";

/** Every field disagrees with the literal `createSection` defaults to, so a
 *  route that echoed the row and a route that synthesised a constant cannot
 *  produce the same response on this data. */
const insertedRow = (): Row => ({
  section_id: SECTION_ID,
  budget_id: BUDGET_ID,
  user_id: USER_ID,
  name: "Renamed",
  roll_over: true,
  roll_over_start_date: "2026-01-15",
  capacities: [{ capacity_id: CAPACITY_ID, month: 1200 }],
  updated: "2026-09-02T00:00:00.000Z",
  is_deleted: false,
});

describe("get-new-section response body", () => {
  test("the response body is the inserted row, not a synthesised default", async () => {
    db.insertReturns = [insertedRow()];

    const result = await getNewSectionRoute.execute(
      makeReq({ user_id: USER_ID, username: "test" }),
      fakeRes(),
    );

    expect(result?.status).toBe("success");
    const { section } = (result as { body: { section: Record<string, unknown> } }).body;
    expect(section.section_id).toBe(SECTION_ID);
    expect(section.budget_id).toBe(BUDGET_ID);
    expect(section.name).toBe("Renamed");
    expect(section.roll_over).toBe(true);
    expect(section.roll_over_start_date).toBe("2026-01-15");
    expect(section.capacities).toEqual([{ capacity_id: CAPACITY_ID, month: 1200 }]);
  });

  test("the response ships only the whitelisted section fields", async () => {
    db.insertReturns = [insertedRow()];

    const result = await getNewSectionRoute.execute(
      makeReq({ user_id: USER_ID, username: "test" }),
      fakeRes(),
    );

    const { section } = (result as { body: { section: Record<string, unknown> } }).body;
    expect(Object.keys(section).sort()).toEqual([
      "budget_id",
      "capacities",
      "name",
      "roll_over",
      "roll_over_start_date",
      "section_id",
    ]);
  });

  test("the insert carries the new-section defaults and the parent budget", async () => {
    db.insertReturns = [insertedRow()];

    await getNewSectionRoute.execute(makeReq({ user_id: USER_ID, username: "test" }), fakeRes());

    const [, values] = mockQuery.mock.calls.find(([sql]) => /^\s*INSERT\s+INTO\s+sections\b/i.test(String(sql)))!;
    expect(values).toContain("New Section");
    expect(values).toContain(false);
    expect(values).toContain(BUDGET_ID);
    expect(values).toContain(USER_ID);
  });

  test("a failed insert reports failure instead of a body", async () => {
    db.insertReturns = [];

    const result = await getNewSectionRoute.execute(
      makeReq({ user_id: USER_ID, username: "test" }),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect((result as { message?: string }).message).toBe("Failed to create section.");
  });

  test("a missing parent never reaches the insert", async () => {
    const result = await getNewSectionRoute.execute(
      makeReq({ user_id: USER_ID, username: "test" }, {}),
      fakeRes(),
    );

    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("an unauthenticated request never reaches the insert", async () => {
    const result = await getNewSectionRoute.execute(makeReq(undefined), fakeRes());

    expect(result?.status).toBe("failed");
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("get-new-section parent ownership", () => {
  const OTHER_USER = "22222222-2222-2222-2222-222222222222";
  const inserts = () => mockQuery.mock.calls.filter(([sql]) => /^\s*INSERT\s+INTO\s+sections\b/i.test(String(sql)));

  test("a budget that exists but belongs to another user is refused before any insert", async () => {
    db.parents = new Map([[BUDGET_ID, OTHER_USER]]);
    db.insertReturns = [insertedRow()];
    const result = await getNewSectionRoute.execute(makeReq({ user_id: USER_ID, username: "u" }), fakeRes());
    expect(result).toEqual({ status: "failed", message: "Failed to create section." });
    expect(inserts()).toHaveLength(0);
  });

  test("a budget that doesn't exist gets the same answer, so the two can't be told apart", async () => {
    db.parents = new Map();
    db.insertReturns = [insertedRow()];
    const result = await getNewSectionRoute.execute(makeReq({ user_id: USER_ID, username: "u" }), fakeRes());
    expect(result).toEqual({ status: "failed", message: "Failed to create section." });
    expect(inserts()).toHaveLength(0);
  });

  test("a parent that isn't a UUID is refused as a bad request, before any query", async () => {
    const result = await getNewSectionRoute.execute(
      makeReq({ user_id: USER_ID, username: "u" }, { parent: "not-a-uuid" }),
      fakeRes(),
    );
    expect(result?.status).toBe("failed");
    expect(result?.message).toMatch(/parent/);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
