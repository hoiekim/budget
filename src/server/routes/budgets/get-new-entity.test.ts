import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import type { ServerRequest, ServerResponse } from "server";

type Row = Record<string, unknown>;

const USER_ID = "11111111-1111-1111-1111-111111111111";
const BUDGET_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const SECTION_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const CATEGORY_ID = "7d444840-9dc0-11d1-b245-5ffdce74fad2";
const CAPACITY_ID = "9c1d3a44-2b6e-4f10-8f7a-1d5c2e6b0a93";
const OTHER_USER = "22222222-2222-2222-2222-222222222222";

/** A parent row's shape, by the table the lookup reads. The shared columns
 *  are the same; the extra column is the parent's own distinguishing field. */
const PARENTS = {
  sections: {
    table: "sections",
    noun: "section",
    idField: "section_id",
    parentId: SECTION_ID,
    extra: { budget_id: BUDGET_ID },
  },
  budgets: {
    table: "budgets",
    noun: "budget",
    idField: "budget_id",
    parentId: BUDGET_ID,
    extra: { iso_currency_code: "USD" },
  },
} as const;

type Parent = (typeof PARENTS)[keyof typeof PARENTS];

const db = {
  insertReturns: [] as Row[],
  /** Each existing parent's owner, by id. */
  parents: new Map<string, string>(),
};

const parentRows = (sql: string, parent: Parent, values: unknown[]): Row[] =>
  [...db.parents]
    .filter(
      ([id, owner]) =>
        values.includes(id) && (!/\buser_id\s*=/i.test(sql) || values.includes(owner)),
    )
    .map(([id, owner]) => ({
      [parent.idField]: id,
      user_id: owner,
      ...parent.extra,
      name: "parent",
      roll_over: false,
      roll_over_start_date: null,
      capacities: [],
      updated: "2026-10-01T00:00:00.000Z",
      is_deleted: false,
    }));

const { driver, mockUnsafe } = createFakeSql(async (sql: string, values: unknown[] = []) => {
  // The parent lookup answers like its WHERE: by id, and by owner only when the query filters on one.
  const rows = /^\s*INSERT\s+INTO\s+(budgets|categories|sections)\b/i.test(sql)
    ? db.insertReturns
    : /FROM\s+sections\b/i.test(sql)
      ? parentRows(sql, PARENTS.sections, values)
      : /FROM\s+budgets\b/i.test(sql)
        ? parentRows(sql, PARENTS.budgets, values)
        : [];
  return { rows: rows as unknown[], rowCount: rows.length as number | null };
});

mock.module("../../lib/postgres/sql-driver", () => driver);

const { getNewBudgetRoute } = await import("./get-new-budget");
const { getNewCategoryRoute } = await import("./get-new-category");
const { getNewSectionRoute } = await import("./get-new-section");

afterAll(() => {
  restoreLeaves();
});

beforeEach(() => {
  mockUnsafe.mockClear();
  db.insertReturns = [];
});

/** Every field disagrees with the literal create defaults, so a route that
 *  echoed the row and a route that synthesised a constant cannot produce the
 *  same response on this data. */
const ENTITIES = [
  {
    noun: "budget",
    table: "budgets",
    route: getNewBudgetRoute,
    bodyKey: "budget",
    failureMessage: "Failed to create budget.",
    insertedRow: (): Row => ({
      budget_id: BUDGET_ID,
      user_id: USER_ID,
      name: "Renamed",
      iso_currency_code: "EUR",
      roll_over: true,
      roll_over_start_date: "2026-01-15",
      capacities: [{ capacity_id: CAPACITY_ID, month: 1200 }],
      updated: "2026-09-02T00:00:00.000Z",
      is_deleted: false,
    }),
    expectedBody: {
      budget_id: BUDGET_ID,
      name: "Renamed",
      iso_currency_code: "EUR",
      roll_over: true,
      roll_over_start_date: "2026-01-15",
      capacities: [{ capacity_id: CAPACITY_ID, month: 1200 }],
    },
    whitelist: [
      "budget_id",
      "capacities",
      "iso_currency_code",
      "name",
      "roll_over",
      "roll_over_start_date",
    ],
    defaultValues: ["New Budget", "USD", false, USER_ID],
    parent: null as Parent | null,
  },
  {
    noun: "category",
    table: "categories",
    route: getNewCategoryRoute,
    bodyKey: "category",
    failureMessage: "Failed to create category.",
    insertedRow: (): Row => ({
      category_id: CATEGORY_ID,
      section_id: SECTION_ID,
      user_id: USER_ID,
      name: "Renamed",
      roll_over: true,
      roll_over_start_date: "2026-01-15",
      capacities: [{ capacity_id: CAPACITY_ID, month: 1200 }],
      updated: "2026-09-02T00:00:00.000Z",
      is_deleted: false,
    }),
    expectedBody: {
      category_id: CATEGORY_ID,
      section_id: SECTION_ID,
      name: "Renamed",
      roll_over: true,
      roll_over_start_date: "2026-01-15",
      capacities: [{ capacity_id: CAPACITY_ID, month: 1200 }],
    },
    whitelist: [
      "capacities",
      "category_id",
      "name",
      "roll_over",
      "roll_over_start_date",
      "section_id",
    ],
    defaultValues: ["New Category", false, SECTION_ID, USER_ID],
    parent: PARENTS.sections as Parent | null,
  },
  {
    noun: "section",
    table: "sections",
    route: getNewSectionRoute,
    bodyKey: "section",
    failureMessage: "Failed to create section.",
    insertedRow: (): Row => ({
      section_id: SECTION_ID,
      budget_id: BUDGET_ID,
      user_id: USER_ID,
      name: "Renamed",
      roll_over: true,
      roll_over_start_date: "2026-01-15",
      capacities: [{ capacity_id: CAPACITY_ID, month: 1200 }],
      updated: "2026-09-02T00:00:00.000Z",
      is_deleted: false,
    }),
    expectedBody: {
      section_id: SECTION_ID,
      budget_id: BUDGET_ID,
      name: "Renamed",
      roll_over: true,
      roll_over_start_date: "2026-01-15",
      capacities: [{ capacity_id: CAPACITY_ID, month: 1200 }],
    },
    whitelist: [
      "budget_id",
      "capacities",
      "name",
      "roll_over",
      "roll_over_start_date",
      "section_id",
    ],
    defaultValues: ["New Section", false, BUDGET_ID, USER_ID],
    parent: PARENTS.budgets as Parent | null,
  },
] as const;

for (const entity of ENTITIES) {
  const makeReq = (
    user?: { user_id: string; username: string },
    query: Record<string, unknown> = entity.parent ? { parent: entity.parent.parentId } : {},
  ): ServerRequest =>
    ({
      method: "GET",
      path: `/new-${entity.noun}`,
      url: `http://x/api/new-${entity.noun}`,
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
    }) as unknown as ServerRequest;

  const fakeRes = (): ServerResponse =>
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
    }) as unknown as ServerResponse;

  describe(`get-new-${entity.noun} response body`, () => {
    beforeEach(() => {
      db.parents = entity.parent
        ? new Map([[entity.parent.parentId, USER_ID]])
        : new Map();
    });

    test("the response body is the inserted row, not a synthesised default", async () => {
      db.insertReturns = [entity.insertedRow()];

      const result = await entity.route.execute(
        makeReq({ user_id: USER_ID, username: "test" }),
        fakeRes(),
      );

      expect(result?.status).toBe("success");
      const body = (
        result as { body: Record<string, Record<string, unknown>> }
      ).body[entity.bodyKey];
      for (const [key, value] of Object.entries(entity.expectedBody)) {
        expect(body[key]).toEqual(value);
      }
    });

    test(`the response ships only the whitelisted ${entity.noun} fields`, async () => {
      db.insertReturns = [entity.insertedRow()];

      const result = await entity.route.execute(
        makeReq({ user_id: USER_ID, username: "test" }),
        fakeRes(),
      );

      const body = (
        result as { body: Record<string, Record<string, unknown>> }
      ).body[entity.bodyKey];
      expect(Object.keys(body).sort()).toEqual(entity.whitelist);
    });

    test(
      `the insert carries the new-${entity.noun} defaults` +
        (entity.parent ? ` and the parent ${entity.parent.noun}` : ""),
      async () => {
        db.insertReturns = [entity.insertedRow()];

        await entity.route.execute(makeReq({ user_id: USER_ID, username: "test" }), fakeRes());

        const [, values] = mockUnsafe.mock.calls.find(([sql]) =>
          new RegExp(`^\\s*INSERT\\s+INTO\\s+${entity.table}\\b`, "i").test(String(sql)),
        )!;
        for (const value of entity.defaultValues) {
          expect(values).toContain(value);
        }
      },
    );

    test("a failed insert reports failure instead of a body", async () => {
      db.insertReturns = [];

      const result = await entity.route.execute(
        makeReq({ user_id: USER_ID, username: "test" }),
        fakeRes(),
      );

      expect(result?.status).toBe("failed");
      expect((result as { message?: string }).message).toBe(entity.failureMessage);
    });

    if (entity.parent) {
      test("a missing parent never reaches the insert", async () => {
        const result = await entity.route.execute(
          makeReq({ user_id: USER_ID, username: "test" }, {}),
          fakeRes(),
        );

        expect(result?.status).toBe("failed");
        expect(mockUnsafe).not.toHaveBeenCalled();
      });
    }

    test("an unauthenticated request never reaches the insert", async () => {
      const result = await entity.route.execute(makeReq(undefined), fakeRes());

      expect(result?.status).toBe("failed");
      expect(mockUnsafe).not.toHaveBeenCalled();
    });
  });

  if (entity.parent) {
    const parent = entity.parent;
    describe(`get-new-${entity.noun} parent ownership`, () => {
      const inserts = () =>
        mockUnsafe.mock.calls.filter(([sql]) =>
          new RegExp(`^\\s*INSERT\\s+INTO\\s+${entity.table}\\b`, "i").test(String(sql)),
        );

      test(`a ${parent.noun} that exists but belongs to another user is refused before any insert`, async () => {
        db.parents = new Map([[parent.parentId, OTHER_USER]]);
        db.insertReturns = [entity.insertedRow()];
        const result = await entity.route.execute(
          makeReq({ user_id: USER_ID, username: "u" }),
          fakeRes(),
        );
        expect(result).toEqual({ status: "failed", message: entity.failureMessage });
        expect(inserts()).toHaveLength(0);
      });

      test(`a ${parent.noun} that doesn't exist gets the same answer, so the two can't be told apart`, async () => {
        db.parents = new Map();
        db.insertReturns = [entity.insertedRow()];
        const result = await entity.route.execute(
          makeReq({ user_id: USER_ID, username: "u" }),
          fakeRes(),
        );
        expect(result).toEqual({ status: "failed", message: entity.failureMessage });
        expect(inserts()).toHaveLength(0);
      });

      test("a parent that isn't a UUID is refused as a bad request, before any query", async () => {
        const result = await entity.route.execute(
          makeReq({ user_id: USER_ID, username: "u" }, { parent: "not-a-uuid" }),
          fakeRes(),
        );
        expect(result?.status).toBe("failed");
        expect(result?.message).toMatch(/parent/);
        expect(mockUnsafe).not.toHaveBeenCalled();
      });
    });
  }
}
