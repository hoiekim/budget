import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";
import { BUDGET_NAME_REQUIRED_MESSAGE, CATEGORY_NAME_REQUIRED_MESSAGE, SECTION_NAME_REQUIRED_MESSAGE } from "common";
import type { ServerRequest, ServerResponse } from "server";

type Row = Record<string, unknown>;

const db = {
  updateReturns: [] as Row[],
  updateError: null as Error | null,
};

const { driver, mockUnsafe, clearSqlMocks } = createFakeSql(async (sql: string, _values?: unknown[]) => {
  const rows = (() => {
    if (/^\s*UPDATE\s+(budgets|categories|sections)\b/i.test(sql)) {
      if (db.updateError) throw db.updateError;
      return db.updateReturns;
    }
    return [];
  })();
  return { rows: rows as unknown[], rowCount: rows.length as number | null };
});

mock.module("../../lib/postgres/sql-driver", () => driver);

// `mock.module` is process-global in Bun and `restoreLeaves` only restores the
// driver / `password` leaves, so spread the real module rather than replacing it —
// `alarm.test.ts` drives `resetAlarmState` — and put it back in `afterAll`
// (the post-plaid-hook.test.ts pattern) so sibling files sharing the process
// exercise the real `sendAlarm`.
const realAlarm = { ...(await import("server/lib/alarm")) };

const mockSendAlarm = mock(async (_title: string, _detail: string, _key?: string) => undefined);
mock.module("server/lib/alarm", () => ({ ...realAlarm, sendAlarm: mockSendAlarm }));

const { postBudgetRoute } = await import("./post-budget");
const { postCategoryRoute } = await import("./post-category");
const { postSectionRoute } = await import("./post-section");

afterAll(() => {
  mock.module("server/lib/alarm", () => realAlarm);
  restoreLeaves();
});

beforeEach(() => {
  clearSqlMocks();
  mockSendAlarm.mockClear();
  db.updateReturns = [];
  db.updateError = null;
});

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const USER = { user_id: "11111111-1111-1111-1111-111111111111", username: "test" };

const makeReq = (noun: string, body: unknown): ServerRequest =>
  ({
    method: "POST",
    path: `/${noun}`,
    url: `http://x/api/${noun}`,
    headers: {},
    query: {},
    body,
    session: {
      id: "s-1",
      user: USER,
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

/**
 * One shared case per entity. The cases are identical modulo the noun, the
 * id field, the well-formed name, and the empty-name message; the null name
 * and the empty name are refused for every entity — all three specs make
 * name non-nullable, and all three carry the empty-name extra check.
 */
const ENTITIES = [
  {
    noun: "budget",
    route: postBudgetRoute,
    idField: "budget_id",
    successName: "Groceries",
    refusesNullName: true,
    refusesEmptyName: true,
    emptyNameMessage: BUDGET_NAME_REQUIRED_MESSAGE,
  },
  {
    noun: "category",
    route: postCategoryRoute,
    idField: "category_id",
    successName: "Groceries",
    refusesNullName: true,
    refusesEmptyName: true,
    emptyNameMessage: CATEGORY_NAME_REQUIRED_MESSAGE,
  },
  {
    noun: "section",
    route: postSectionRoute,
    idField: "section_id",
    successName: "Essentials",
    refusesNullName: true,
    refusesEmptyName: true,
    emptyNameMessage: SECTION_NAME_REQUIRED_MESSAGE,
  },
] as const;

for (const entity of ENTITIES) {
  describe(`post-${entity.noun} typed body fields`, () => {
    // Stage a matching row AND arm the write to fail the way Postgres fails on a
    // bad value, so a missing guard reaches the query and pages the alarm.
    const rejects = async (body: unknown, expectedError: string) => {
      db.updateReturns = [{ [entity.idField]: UUID }];
      db.updateError = new Error('invalid input syntax for type date: "hello"');

      const result = await entity.route.execute(makeReq(entity.noun, body), fakeRes());

      expect(result?.status).toBe("failed");
      expect((result as { message?: string })?.message).toBe(expectedError);
      expect(mockUnsafe).not.toHaveBeenCalled();
      expect(mockSendAlarm).not.toHaveBeenCalled();
    };

    test(`a non-UUID ${entity.idField} is refused before it reaches the WHERE clause`, async () => {
      await rejects({ [entity.idField]: "not-a-uuid" }, `Field ${entity.idField} must be a uuid`);
    });

    test("a string in the roll_over boolean column is refused before SQL", async () => {
      await rejects({ [entity.idField]: UUID, roll_over: "yes" }, "Field roll_over must be a boolean");
    });

    test("a non-date roll_over_start_date is refused before it reaches the DATE column", async () => {
      for (const value of ["hello", "", "2026-02-30"]) {
        clearSqlMocks();
        mockSendAlarm.mockClear();
        await rejects(
          { [entity.idField]: UUID, roll_over_start_date: value },
          "Field roll_over_start_date must be a date",
        );
      }
    });

    if (entity.refusesNullName) {
      test("an explicit null name is refused before it can break the client's select", async () => {
        await rejects({ [entity.idField]: UUID, name: null }, "Field name must be a string");
      });
    }

    if (entity.refusesEmptyName) {
      test("a blank name is refused by the extra check before it reaches the repo", async () => {
        for (const name of ["", "   "]) {
          clearSqlMocks();
          mockSendAlarm.mockClear();
          await rejects(
            {
              [entity.idField]: UUID,
              name,
              roll_over: true,
              roll_over_start_date: "2026-08-24T00:00:00",
              capacities: [{ month: 100 }],
            },
            entity.emptyNameMessage,
          );
        }
      });
    }

    test("a non-array capacities is refused before it lands in the JSONB column", async () => {
      for (const capacities of ["abc", 5, { a: 1 }, null]) {
        clearSqlMocks();
        mockSendAlarm.mockClear();
        await rejects({ [entity.idField]: UUID, capacities }, "Field capacities must be an array");
      }
    });

    test("a well-formed body passes validation and reaches the repo", async () => {
      db.updateReturns = [{ [entity.idField]: UUID }];
      const result = await entity.route.execute(
        makeReq(entity.noun, {
          [entity.idField]: UUID,
          name: entity.successName,
          roll_over: true,
          // What the client serializes, via `getDateTimeString`.
          roll_over_start_date: "2026-08-24T00:00:00",
          capacities: [{ month: 100 }],
        }),
        fakeRes(),
      );
      expect(result?.status).toBe("success");
      expect(mockUnsafe).toHaveBeenCalled();
      expect(mockSendAlarm).not.toHaveBeenCalled();
    });
  });
}
