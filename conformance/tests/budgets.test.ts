import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUserClient, startStack, type ApiClient, type Stack } from "../harness";
import { NO_SUCH_ID, uuidQueryCases } from "../harness/query-cases";
import {
  seedApiKey,
  seedBudget,
  seedCategory,
  seedLabeledRows,
  seedSection,
  setJsonb,
  softDelete,
  storedLabels,
  storedRow,
  storedRows,
  updatedLater,
  withInsertsDropped,
  type StoredRow,
} from "../harness/seed/budgets";

let stack: Stack;
let admin: ApiClient;
let adminId: string;
/** Another user, signed in: never the owner of what `admin` makes. */
let second: ApiClient;
let secondId: string;
beforeAll(async () => {
  stack = await startStack();
  admin = await stack.login();
  adminId = await stack.userId("admin");
  const created = await createUserClient(stack, "second-budgeter");
  second = created.client;
  secondId = created.user.user_id;
});
afterAll(() => stack.stop());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUCCESS = { status: "success" };
const SERVER_ERROR = { status: "error", message: "Internal server error" };
const failed = (message: string) => ({ status: "failed", message });

type Noun = "budget" | "section" | "category";
type Family = Record<string, unknown>;
interface BudgetsBody {
  budgets: Family[];
  sections: Family[];
  categories: Family[];
}

const newBudget = async (client: ApiClient): Promise<string> =>
  (await client.get<{ budget: { budget_id: string } }>("/new-budget")).body.budget.budget_id;
const newSection = async (client: ApiClient, budget_id: string): Promise<string> =>
  (await client.get<{ section: { section_id: string } }>("/new-section", { query: { parent: budget_id } })).body.section.section_id;
const newCategory = async (client: ApiClient, section_id: string): Promise<string> =>
  (await client.get<{ category: { category_id: string } }>("/new-category", { query: { parent: section_id } })).body.category
    .category_id;

interface Entity {
  noun: Noun;
  table: "budgets" | "sections" | "categories";
  idField: string;
  /** The column naming the row above it. */
  parentField?: string;
  idLogKey: string;
  emptyNameMessage: string;
  /** Makes one through the API, under parents of its own. */
  create: (client: ApiClient) => Promise<string>;
}

const ENTITIES: Entity[] = [
  {
    noun: "budget",
    table: "budgets",
    idField: "budget_id",
    idLogKey: "budgetId",
    emptyNameMessage: "Budget name cannot be empty.",
    create: newBudget,
  },
  {
    noun: "section",
    table: "sections",
    idField: "section_id",
    parentField: "budget_id",
    idLogKey: "sectionId",
    emptyNameMessage: "Section name cannot be empty.",
    create: async (client) => newSection(client, await newBudget(client)),
  },
  {
    noun: "category",
    table: "categories",
    idField: "category_id",
    parentField: "section_id",
    idLogKey: "categoryId",
    emptyNameMessage: "Category name cannot be empty.",
    create: async (client) => newCategory(client, await newSection(client, await newBudget(client))),
  },
];
const [BUDGET, SECTION, CATEGORY] = ENTITIES;

const stored = async (entity: Entity, id: string): Promise<StoredRow> => {
  const row = await storedRow(stack, entity.table, id);
  if (!row) throw new Error(`no ${entity.noun} ${id}`);
  return row;
};

/** What the API answers for a stored row: the owner and the bookkeeping columns are left out, and so is a start date that is not set. */
const jsonOf = (entity: Entity, row: StoredRow): Family => {
  const json: Family = { [entity.idField]: row[entity.idField], name: row.name, roll_over: row.roll_over, capacities: row.capacities };
  if (entity.parentField) json[entity.parentField] = row[entity.parentField];
  if (entity.noun === "budget") json.iso_currency_code = row.iso_currency_code;
  if (row.roll_over_start_date) json.roll_over_start_date = row.roll_over_start_date;
  return json;
};

const byId = (entity: Entity, rows: Family[]): Family[] =>
  [...rows].sort((a, b) => String(a[entity.idField]).localeCompare(String(b[entity.idField])));

const listed = async (client: ApiClient): Promise<BudgetsBody> => {
  const result = await client.get<BudgetsBody>("/budgets");
  expect(result.status).toBe(200);
  expect(result.json.status).toBe("success");
  return result.body;
};

/** The entity as `GET /budgets` lists it for `client`, or `undefined`. */
const listedOne = async (client: ApiClient, entity: Entity, id: string): Promise<Family | undefined> =>
  (await listed(client))[entity.table].find((row) => row[entity.idField] === id);

const alarmsFor = (route: string) =>
  stack.upstream.discord.alarms().filter((alarm) => alarm.title === `🚨 Budget Server Error: Route Error: ${route}`);

/** A user of their own, so what they list is exactly what the test gave them. */
const freshUser = async (name: string): Promise<{ client: ApiClient; user_id: string }> => {
  const { client, user } = await createUserClient(stack, name);
  return { client, user_id: user.user_id };
};

describe("a caller without a session", () => {
  let budget_id: string;
  let section_id: string;
  let category_id: string;
  beforeAll(async () => {
    budget_id = await seedBudget(stack, adminId);
    section_id = await seedSection(stack, adminId, budget_id);
    category_id = await seedCategory(stack, adminId, section_id);
  });

  const requests = (): [string, string, unknown?][] => [
    ["GET", "/budgets"],
    ["GET", "/new-budget"],
    ["GET", `/new-section?parent=${budget_id}`],
    ["GET", `/new-category?parent=${section_id}`],
    ["POST", "/budget", { budget_id, name: "Taken" }],
    ["POST", "/section", { section_id, name: "Taken" }],
    ["POST", "/category", { category_id, name: "Taken" }],
    ["DELETE", `/budget?id=${budget_id}`],
    ["DELETE", `/section?id=${section_id}`],
    ["DELETE", `/category?id=${category_id}`],
  ];
  const everything = async () => ({
    budgets: await storedRows(stack, "budgets"),
    sections: await storedRows(stack, "sections"),
    categories: await storedRows(stack, "categories"),
  });

  test("is refused on every route, and nothing is created, changed or deleted", async () => {
    const before = await everything();
    const anonymous = stack.anonymous();
    for (const [method, path, body] of requests()) {
      const result = await anonymous.request(method, path, { body });
      expect([method, path, result.status]).toEqual([method, path, 401]);
      expect(result.json).toEqual(failed("Not authenticated."));
      expect(result.setCookies).toEqual([]);
    }
    expect(await everything()).toEqual(before);
  });

  test("is refused all the same with an API key: these routes take a session only", async () => {
    const key = await seedApiKey(stack, adminId, ["transactions:suggest", "budgets:read", "budgets:write"]);
    const before = await everything();
    const keyed = stack.anonymous();
    for (const [method, path, body] of requests()) {
      const result = await keyed.request(method, path, { body, headers: { Authorization: `Bearer ${key}`, "X-Real-IP": "10.40.0.1" } });
      expect([method, path, result.status]).toEqual([method, path, 401]);
      expect(result.json).toEqual(failed("Not authenticated."));
      expect(result.setCookies).toEqual([]);
    }
    expect(await everything()).toEqual(before);
    // The key was not even looked up.
    expect((await stack.db.rows("api_keys", { user_id: adminId })).map((row) => row.last_used_at)).toEqual([null]);
  });
});

describe("GET /new-budget", () => {
  test("creates a budget with the defaults, answers with it and stores it for the caller", async () => {
    const result = await admin.get<{ budget: Family }>("/new-budget");
    expect(result.status).toBe(200);
    const budget_id = result.body.budget.budget_id as string;
    expect(budget_id).toMatch(UUID);
    expect(result.json).toEqual({
      status: "success",
      body: { budget: { budget_id, name: "New Budget", iso_currency_code: "USD", roll_over: false, capacities: [] } },
    });
    const row = await stored(BUDGET, budget_id);
    expect(row).toEqual({
      budget_id,
      user_id: adminId,
      name: "New Budget",
      iso_currency_code: "USD",
      roll_over: false,
      roll_over_start_date: null,
      capacities: [],
      updated: expect.any(String),
      is_deleted: false,
    });
    expect(Math.abs(Date.parse(row.updated as string) - Date.now())).toBeLessThan(60_000);
    expect(await listedOne(admin, BUDGET, budget_id)).toEqual(result.body.budget);
  });

  test("takes nothing from the query, and makes a new budget every time", async () => {
    const query = { parent: NO_SUCH_ID, budget_id: NO_SUCH_ID, name: "Mine", iso_currency_code: "EUR", roll_over: "true" };
    const first = await admin.get<{ budget: Family }>("/new-budget", { query });
    const again = await admin.get<{ budget: Family }>("/new-budget", { query });
    for (const result of [first, again]) {
      expect(result.json).toEqual({
        status: "success",
        body: {
          budget: {
            budget_id: expect.stringMatching(UUID),
            name: "New Budget",
            iso_currency_code: "USD",
            roll_over: false,
            capacities: [],
          },
        },
      });
      expect(result.body.budget.budget_id).not.toBe(NO_SUCH_ID);
    }
    expect(again.body.budget.budget_id).not.toBe(first.body.budget.budget_id);
  });

  test("answers that it failed when the insert stored no row", async () => {
    const { client, user_id } = await freshUser("no-budget-stored");
    await withInsertsDropped(stack, "budgets", async () => {
      const result = await client.get("/new-budget");
      expect(result.status).toBe(200);
      expect(result.json).toEqual(failed("Failed to create budget."));
    });
    expect(await storedRows(stack, "budgets", { user_id })).toEqual([]);
  });
});

for (const [entity, parent, defaultName] of [
  [SECTION, BUDGET, "New Section"],
  [CATEGORY, SECTION, "New Category"],
] as const) {
  const path = `/new-${entity.noun}`;
  const failure = `Failed to create ${entity.noun}.`;
  const parentField = parent.idField;

  describe(`GET ${path}`, () => {
    test(`creates a ${entity.noun} with the defaults under the caller's ${parent.noun}`, async () => {
      const parentId = await parent.create(admin);
      const result = await admin.get<Record<string, Family>>(path, { query: { parent: parentId } });
      expect(result.status).toBe(200);
      const id = result.body[entity.noun][entity.idField] as string;
      expect(id).toMatch(UUID);
      expect(result.json).toEqual({
        status: "success",
        body: {
          [entity.noun]: { [entity.idField]: id, [parentField]: parentId, name: defaultName, roll_over: false, capacities: [] },
        },
      });
      expect(await stored(entity, id)).toEqual({
        [entity.idField]: id,
        user_id: adminId,
        [parentField]: parentId,
        name: defaultName,
        roll_over: false,
        roll_over_start_date: null,
        capacities: [],
        updated: expect.any(String),
        is_deleted: false,
      });
      expect(await listedOne(admin, entity, id)).toEqual(result.body[entity.noun]);

      // Each call makes another one, and the id reads the same in upper case.
      const again = await admin.get<Record<string, Family>>(path, { query: { parent: parentId.toUpperCase(), name: "Mine" } });
      expect(again.json).toEqual({
        status: "success",
        body: {
          [entity.noun]: {
            [entity.idField]: expect.stringMatching(UUID),
            [parentField]: parentId,
            name: defaultName,
            roll_over: false,
            capacities: [],
          },
        },
      });
      expect(again.body[entity.noun][entity.idField]).not.toBe(id);
      expect(await storedRows(stack, entity.table, { [parentField]: parentId })).toHaveLength(2);
    });

    test(`needs one parent that is a ${parent.noun} id`, async () => {
      const mine = await storedRows(stack, entity.table, { user_id: adminId });
      for (const [query, message] of uuidQueryCases("parent")) {
        const result = await admin.get(`${path}${query}`);
        expect([query, result.status, result.json]).toEqual([query, 200, failed(message)]);
      }
      expect(await storedRows(stack, entity.table, { user_id: adminId })).toEqual(mine);
    });

    test(`refuses a ${parent.noun} that is missing, deleted or another user's with one answer`, async () => {
      const others = await parent.create(second);
      const deleted = await parent.create(admin);
      await softDelete(stack, parent.table, deleted);
      // The other way round as well: the row above it is the caller's, but it is not that kind of row.
      const wrongKind = entity === CATEGORY ? await newBudget(admin) : await newSection(admin, await newBudget(admin));
      const count = async () => (await storedRows(stack, entity.table)).length;
      const before = await count();
      for (const parentId of [NO_SUCH_ID, others, deleted, wrongKind]) {
        const result = await admin.get(path, { query: { parent: parentId } });
        expect(result.status).toBe(200);
        expect(result.json).toEqual(failed(failure));
      }
      expect(await count()).toBe(before);
      // Its owner still can.
      expect((await second.get(path, { query: { parent: others } })).json.status).toBe("success");
    });

    test("answers that it failed when the insert stored no row", async () => {
      const parentId = await parent.create(admin);
      await withInsertsDropped(stack, entity.table, async () => {
        const result = await admin.get(path, { query: { parent: parentId } });
        expect(result.status).toBe(200);
        expect(result.json).toEqual(failed(failure));
      });
      expect(await storedRows(stack, entity.table, { [parentField]: parentId })).toEqual([]);
    });
  });
}

describe("GET /new-category", () => {
  test("looks only at the section, not at the budget above it", async () => {
    const budget_id = await newBudget(admin);
    const section_id = await newSection(admin, budget_id);
    await softDelete(stack, "budgets", budget_id);
    const result = await admin.get<{ category: Family }>("/new-category", { query: { parent: section_id } });
    expect(result.json).toEqual({
      status: "success",
      body: {
        category: {
          category_id: expect.stringMatching(UUID),
          section_id,
          name: "New Category",
          roll_over: false,
          capacities: [],
        },
      },
    });
  });
});

for (const entity of ENTITIES) {
  const path = `/${entity.noun}`;
  const { idField } = entity;
  const isBudget = entity.noun === "budget";

  describe(`POST ${path}`, () => {
    /** One of the admin's, named by every request that must be refused: none may change it. */
    let id: string;
    let untouched: StoredRow;
    beforeAll(async () => {
      id = await entity.create(admin);
      untouched = await stored(entity, id);
    });

    const post = (body: unknown, client: ApiClient = admin) => client.post(path, body);

    test("needs a JSON object for a body", async () => {
      const bodies: [unknown, string][] = [
        [null, "Request body is required"],
        [[], "Request body must be an object"],
        [[{ [idField]: id, name: "In a list" }], "Request body must be an object"],
        ["name", "Request body must be an object"],
        [5, "Request body must be an object"],
        [0, "Request body must be an object"],
        [true, "Request body must be an object"],
        [false, "Request body must be an object"],
      ];
      for (const [body, message] of bodies) {
        const result = await post(body);
        expect([body, result.status, result.json]).toEqual([body, 200, failed(message)]);
      }
      const none = await admin.request("POST", path);
      expect(none.json).toEqual(failed("Request body is required"));
      const notJson = await admin.request("POST", path, { rawBody: "{bad", headers: { "Content-Type": "application/json" } });
      expect(notJson.json).toEqual(failed("Request body is required"));
      const unlabeled = await admin.request("POST", path, {
        rawBody: JSON.stringify({ [idField]: id, name: "Unlabeled" }),
        headers: { "Content-Type": "text/plain" },
      });
      expect(unlabeled.json).toEqual(failed("Request body is required"));
      expect(await stored(entity, id)).toEqual(untouched);
    });

    test(`needs ${idField} as a string that is a UUID`, async () => {
      const ids: [unknown, string][] = [
        [undefined, `Missing required field: ${idField}`],
        [null, `Missing required field: ${idField}`],
        [5, `Field ${idField} must be a string`],
        [0, `Field ${idField} must be a string`],
        [true, `Field ${idField} must be a string`],
        [{ id }, `Field ${idField} must be a string`],
        [[id], `Field ${idField} must be a string`],
        ["", `Field ${idField} must be a uuid`],
        ["not-a-uuid", `Field ${idField} must be a uuid`],
        [id.replace(/-/g, ""), `Field ${idField} must be a uuid`],
        [`{${id}}`, `Field ${idField} must be a uuid`],
        [` ${id}`, `Field ${idField} must be a uuid`],
        [`${id}\n`, `Field ${idField} must be a uuid`],
        [`${id}0`, `Field ${idField} must be a uuid`],
      ];
      for (const [value, message] of ids) {
        const result = await post({ [idField]: value, name: "Renamed" });
        expect([value, result.status, result.json]).toEqual([value, 200, failed(message)]);
      }
      expect(await stored(entity, id)).toEqual(untouched);
    });

    test("refuses each field of the wrong type, null where the client cannot take it, or past its column", async () => {
      const mustBe = (field: string, kind: string) => `Field ${field} must be ${kind}`;
      const cases: [string, unknown, string][] = [
        ["name", null, mustBe("name", "a string")],
        ["name", 5, mustBe("name", "a string")],
        ["name", true, mustBe("name", "a string")],
        ["name", { text: "Name" }, mustBe("name", "a string")],
        ["name", ["Name"], mustBe("name", "a string")],
        ["name", "n".repeat(256), "Field name must be at most 255 characters"],
        // Counted as JavaScript counts a string: two per character outside the basic plane.
        ["name", "😀".repeat(128), "Field name must be at most 255 characters"],
        ["roll_over", "true", mustBe("roll_over", "a boolean")],
        ["roll_over", "", mustBe("roll_over", "a boolean")],
        ["roll_over", 1, mustBe("roll_over", "a boolean")],
        ["roll_over", 0, mustBe("roll_over", "a boolean")],
        ["roll_over", {}, mustBe("roll_over", "a boolean")],
        ["roll_over", [true], mustBe("roll_over", "a boolean")],
        ["roll_over_start_date", 20260105, mustBe("roll_over_start_date", "a date")],
        ["roll_over_start_date", true, mustBe("roll_over_start_date", "a date")],
        ["roll_over_start_date", {}, mustBe("roll_over_start_date", "a date")],
        ["roll_over_start_date", ["2026-01-05"], mustBe("roll_over_start_date", "a date")],
        ["capacities", null, mustBe("capacities", "an array")],
        ["capacities", {}, mustBe("capacities", "an array")],
        ["capacities", { 0: { capacity_id: "c", month: 1 }, length: 1 }, mustBe("capacities", "an array")],
        ["capacities", "[]", mustBe("capacities", "an array")],
        ["capacities", "", mustBe("capacities", "an array")],
        ["capacities", 5, mustBe("capacities", "an array")],
        ["capacities", true, mustBe("capacities", "an array")],
      ];
      if (isBudget) {
        cases.push(
          ["iso_currency_code", 5, mustBe("iso_currency_code", "a string")],
          ["iso_currency_code", false, mustBe("iso_currency_code", "a string")],
          ["iso_currency_code", { code: "USD" }, mustBe("iso_currency_code", "a string")],
          ["iso_currency_code", ["USD"], mustBe("iso_currency_code", "a string")],
          ["iso_currency_code", "ABCDEFGHIJK", "Field iso_currency_code must be at most 10 characters"],
        );
      }
      for (const [field, value, message] of cases) {
        const result = await post({ [idField]: id, [field]: value });
        expect([field, value, result.status, result.json]).toEqual([field, value, 200, failed(message)]);
      }
      expect(await stored(entity, id)).toEqual(untouched);
    });

    test("refuses a roll-over start date that is not a day on the calendar", async () => {
      const dates = [
        "",
        "today",
        "2026-02-30",
        "2026-04-31",
        "2023-02-29",
        "1900-02-29",
        "2026-13-01",
        "2026-00-10",
        "2026-01-00",
        "2026-01-32",
        "2026-1-5",
        "26-01-05",
        "02026-01-05",
        "2026/01/05",
        "01-05-2026",
        "20260105",
        "2026-01-05T",
        "2026-01-05Tjunk",
        "2026-01-05T25:00:00",
        "2026-01-05x",
        "2026-01-05Z",
        " 2026-01-05",
        "2026-01-05\n",
        "2026-01-05T00:00:00\n",
        // `Date.UTC` reads a year below 100 as 19xx, so no such day checks out.
        "0000-01-01",
        "0099-12-31",
      ];
      for (const date of dates) {
        const result = await post({ [idField]: id, roll_over_start_date: date });
        expect([date, result.status, result.json]).toEqual([date, 200, failed("Field roll_over_start_date must be a date")]);
      }
      expect(await stored(entity, id)).toEqual(untouched);
    });

    test("refuses a name that is blank, after everything else checked out", async () => {
      // Everything `String.prototype.trim` removes.
      const blanks = ["", " ", "   ", "\t\n\u000b\u000c\r", "        　﻿"];
      for (const name of blanks) {
        const result = await post({ [idField]: id, name, roll_over: true });
        expect([name, result.status, result.json]).toEqual([name, 200, failed(entity.emptyNameMessage)]);
      }
      expect(await stored(entity, id)).toEqual(untouched);
    });

    test("names the first thing wrong, the id before the fields and a blank name last", async () => {
      const wrong = { capacities: null, roll_over_start_date: "someday", roll_over: "yes" };
      const order: [Family, string][] = [
        [{ ...wrong, name: 5 }, `Missing required field: ${idField}`],
        [{ ...wrong, name: 5, [idField]: 5 }, `Field ${idField} must be a string`],
        [{ ...wrong, name: 5, [idField]: "nope" }, `Field ${idField} must be a uuid`],
        [{ ...wrong, name: 5, [idField]: id }, "Field name must be a string"],
        [{ ...wrong, name: " ", [idField]: id }, "Field roll_over must be a boolean"],
        [{ ...wrong, name: " ", [idField]: id, roll_over: null }, "Field roll_over_start_date must be a date"],
        [{ ...wrong, name: " ", [idField]: id, roll_over: null, roll_over_start_date: null }, "Field capacities must be an array"],
        [{ name: " ", [idField]: id, roll_over: null, roll_over_start_date: null, capacities: [] }, entity.emptyNameMessage],
      ];
      if (isBudget) order.push([{ ...wrong, [idField]: id, iso_currency_code: 5 }, "Field iso_currency_code must be a string"]);
      for (const [body, message] of order) {
        const result = await post(body);
        expect([body, result.status, result.json]).toEqual([body, 200, failed(message)]);
      }
      expect(await stored(entity, id)).toEqual(untouched);
    });

    test("writes every field given, and nothing else of the row", async () => {
      const target = await entity.create(admin);
      const before = await stored(entity, target);
      const capacities = [
        { capacity_id: "cap-1", month: 1250.5, active_from: "2026-01-01", is_synced: true },
        { capacity_id: "cap-2", month: 0 },
      ];
      const changes: Family = { name: "Household", roll_over: true, roll_over_start_date: "2026-01-05", capacities };
      if (isBudget) changes.iso_currency_code = "EUR";

      const result = await post({ [idField]: target, ...changes });
      expect(result.status).toBe(200);
      expect(result.json).toEqual(SUCCESS);

      const after = await stored(entity, target);
      expect(after).toEqual({ ...before, ...changes, updated: expect.any(String) });
      expect(updatedLater(after, before)).toBe(true);
      expect(await listedOne(admin, entity, target)).toEqual({
        [idField]: target,
        ...(entity.parentField ? { [entity.parentField]: before[entity.parentField] } : {}),
        ...changes,
      });
    });

    test("changes only the fields a body carries, and null clears a column that may be empty", async () => {
      const target = await entity.create(admin);
      const full: Family = {
        name: "Before",
        roll_over: true,
        roll_over_start_date: "2026-01-05",
        capacities: [{ capacity_id: "cap-1", month: 10 }],
      };
      if (isBudget) full.iso_currency_code = "EUR";
      expect((await post({ [idField]: target, ...full })).json).toEqual(SUCCESS);
      const before = await stored(entity, target);

      const steps: Family[] = [
        { name: "Renamed" },
        { roll_over: false },
        { roll_over_start_date: "2027-12-31" },
        { capacities: [] },
        { roll_over: null, roll_over_start_date: null },
        { name: "n".repeat(255) },
        // 255 as JavaScript counts: 127 characters outside the basic plane and one inside.
        { name: `${"😀".repeat(127)}x` },
        // Not white space to JavaScript, so not blank: next line, zero-width space, Mongolian vowel separator.
        { name: "\u0085" },
        { name: "​" },
        { name: "᠎" },
        { name: " padded " },
      ];
      if (isBudget) steps.push({ iso_currency_code: "ABCDEFGHIJ" }, { iso_currency_code: "" }, { iso_currency_code: null });

      let expected = before;
      for (const step of steps) {
        const result = await post({ [idField]: target, ...step });
        expect([step, result.status, result.json]).toEqual([step, 200, SUCCESS]);
        const after = await stored(entity, target);
        expect(after).toEqual({ ...expected, ...step, updated: expect.any(String) });
        expect(updatedLater(after, expected)).toBe(true);
        expected = after;
      }

      const shown = await listedOne(admin, entity, target);
      expect(shown).toEqual(jsonOf(entity, expected));
      expect(shown?.roll_over).toBeNull();
      expect(shown).not.toHaveProperty("roll_over_start_date");
    });

    test("writes nothing when the body names no field it writes, whatever else it carries", async () => {
      const target = await entity.create(admin);
      const before = await stored(entity, target);
      const elsewhere = await entity.create(admin);
      const bodies: Family[] = [
        { [idField]: target },
        {
          [idField]: target,
          user_id: secondId,
          is_deleted: true,
          updated: "2000-01-01T00:00:00.000Z",
          nonsense: { name: "Nested" },
          Name: "Wrong case",
        },
      ];
      // A row cannot be moved, nor renumbered: the row above it is not a field, and neither is another row's id.
      if (entity.parentField) bodies.push({ [idField]: target, [entity.parentField]: (await stored(entity, elsewhere))[entity.parentField] });
      // Only a budget has a currency: elsewhere the key is not looked at, whatever it holds.
      if (!isBudget) bodies.push({ [idField]: target, iso_currency_code: 5 });
      for (const body of bodies) {
        const result = await post(body);
        expect([body, result.status, result.json]).toEqual([body, 200, SUCCESS]);
        expect(await stored(entity, target)).toEqual(before);
      }
    });

    test("stores capacities as the array sent, whatever it holds", async () => {
      const target = await entity.create(admin);
      const shapes: unknown[][] = [
        [{ capacity_id: "c1", month: 100 }],
        [
          { capacity_id: "c1", month: 100.25, active_from: "2026-01-01", is_synced: false },
          { capacity_id: "c2", month: -50, active_from: "2027-06-15", is_synced: true },
          { capacity_id: "c3", month: 0 },
        ],
        // Nothing checks the items: any JSON goes in, and numbers are held as JavaScript holds them.
        [
          1,
          -0,
          1.5,
          1e21,
          1e-7,
          12345678901234567890,
          0.1234567890123456789,
          "text",
          "",
          null,
          true,
          false,
          [1, [2, []]],
          {},
          { b: 1, "10": 2, a: { z: 1, "2": 2 } },
          'ünï©ödé 😀 " \\ \n  ',
        ],
        Array.from({ length: 300 }, (_, i) => ({ capacity_id: `c${i}`, month: i * 1.5, active_from: "2026-01-01" })),
        [],
      ];
      for (const capacities of shapes) {
        expect((await post({ [idField]: target, capacities })).json).toEqual(SUCCESS);
        const sent = JSON.parse(JSON.stringify(capacities));
        expect((await stored(entity, target)).capacities).toEqual(sent);
        expect((await listedOne(admin, entity, target))?.capacities).toEqual(sent);
      }
    });

    test("takes a roll-over start date with or without a time of day, and stores the day", async () => {
      const target = await entity.create(admin);
      const dates: [string, string][] = [
        ["2026-01-05", "2026-01-05"],
        ["2024-02-29", "2024-02-29"],
        ["2000-02-29", "2000-02-29"],
        ["2026-12-31T00:00:00", "2026-12-31"],
        ["2026-01-05T10:20:30Z", "2026-01-05"],
        ["2026-01-05T10:20:30.123456", "2026-01-05"],
        // The day as written, wherever that instant falls in UTC.
        ["2026-01-05T23:30:00-08:00", "2026-01-05"],
        ["2026-01-05T00:30:00+09:00", "2026-01-05"],
        ["2026-01-05T24:00:00", "2026-01-05"],
        ["2026-01-05 10:20", "2026-01-05"],
        ["2026-01-05 ", "2026-01-05"],
        ["0100-01-01", "0100-01-01"],
        ["9999-12-31", "9999-12-31"],
      ];
      for (const [sent, day] of dates) {
        const result = await post({ [idField]: target, roll_over_start_date: sent });
        expect([sent, result.status, result.json]).toEqual([sent, 200, SUCCESS]);
        expect([sent, (await stored(entity, target)).roll_over_start_date]).toEqual([sent, day]);
        expect([sent, (await listedOne(admin, entity, target))?.roll_over_start_date]).toEqual([sent, day]);
      }
    });

    test("answers success and changes nothing for a row that is missing, deleted or another user's", async () => {
      const changes: Family = { name: "Taken over", roll_over: true, roll_over_start_date: "2026-01-05", capacities: [{ capacity_id: "x", month: 1 }] };

      expect((await post({ [idField]: NO_SUCH_ID, ...changes })).json).toEqual(SUCCESS);
      expect(await storedRow(stack, entity.table, NO_SUCH_ID)).toBeUndefined();

      const others = await entity.create(admin);
      const othersBefore = await stored(entity, others);
      const result = await post({ [idField]: others, ...changes }, second);
      expect(result.status).toBe(200);
      expect(result.json).toEqual(SUCCESS);
      expect(await stored(entity, others)).toEqual(othersBefore);
      // The id in upper case is the same row, and its owner changes it.
      expect((await post({ [idField]: others.toUpperCase(), name: "Mine still" })).json).toEqual(SUCCESS);
      expect((await stored(entity, others)).name).toBe("Mine still");

      const deleted = await entity.create(admin);
      await softDelete(stack, entity.table, deleted);
      const deletedBefore = await stored(entity, deleted);
      expect((await post({ [idField]: deleted, ...changes })).json).toEqual(SUCCESS);
      expect(await stored(entity, deleted)).toEqual(deletedBefore);
    });

    test("fails as a server error, and changes nothing, on text Postgres will not store", async () => {
      const target = await entity.create(admin);
      const before = await stored(entity, target);
      const route = `POST ${path}`;
      expect(alarmsFor(route)).toHaveLength(0);

      const nulName = await post({ [idField]: target, name: "nul\u0000byte", roll_over: true });
      expect(nulName.status).toBe(500);
      expect(nulName.json).toEqual(SERVER_ERROR);
      await stack.waitFor(() => alarmsFor(route).length > 0, { what: `the ${route} alarm` });
      expect(alarmsFor(route)[0].description).toBe('**Error:** invalid byte sequence for encoding "UTF8": 0x00');
      await stack.waitForLog(`Failed to update ${entity.noun} {"${entity.idLogKey}":"${target}"}`);
      await stack.waitForLog(`Route handler error {"method":"POST","path":"${path}"}`);

      // JSONB holds no NUL either, however it is written.
      const nulCapacity = await post({ [idField]: target, name: "Fine", capacities: [{ capacity_id: "c\u0000" }] });
      expect(nulCapacity.status).toBe(500);
      expect(nulCapacity.json).toEqual(SERVER_ERROR);

      expect(await stored(entity, target)).toEqual(before);
      // One alarm a minute per route.
      expect(alarmsFor(route)).toHaveLength(1);
    });
  });
}

for (const entity of ENTITIES) {
  const path = `/${entity.noun}`;
  const remove = (id: string, client: ApiClient = admin) => client.delete(path, { query: { id } });

  describe(`DELETE ${path}`, () => {
    test("needs one id that is a UUID", async () => {
      const id = await entity.create(admin);
      const before = await stored(entity, id);
      for (const [query, message] of uuidQueryCases("id")) {
        const result = await admin.request("DELETE", `${path}${query}`);
        expect([query, result.status, result.json]).toEqual([query, 200, failed(message)]);
      }
      // A body is not where the id is read from.
      const inBody = await admin.request("DELETE", path, { body: { id } });
      expect(inBody.json).toEqual(failed("Missing required parameter: id"));
      expect(await stored(entity, id)).toEqual(before);
    });

    test("marks the caller's row deleted, and it is no longer listed", async () => {
      const id = await entity.create(admin);
      const before = await stored(entity, id);
      const result = await remove(id);
      expect(result.status).toBe(200);
      expect(result.json).toEqual(SUCCESS);
      const after = await stored(entity, id);
      expect(after).toEqual({ ...before, is_deleted: true, updated: expect.any(String) });
      expect(updatedLater(after, before)).toBe(true);
      expect(await listedOne(admin, entity, id)).toBeUndefined();

      // Deleting it again, by its id in upper case, answers the same and stamps the row again.
      expect((await remove(id.toUpperCase())).json).toEqual(SUCCESS);
      const again = await stored(entity, id);
      expect(again).toEqual({ ...after, updated: expect.any(String) });
      expect(updatedLater(again, after)).toBe(true);
    });

    test("answers success and deletes nothing for an id no row has", async () => {
      const count = async () => (await storedRows(stack, entity.table, { is_deleted: true })).length;
      const before = await count();
      const result = await remove(NO_SUCH_ID);
      expect(result.status).toBe(200);
      expect(result.json).toEqual(SUCCESS);
      expect(await count()).toBe(before);
    });
  });
}

describe("DELETE /budget", () => {
  test("takes the budget's live sections and their categories with it, in one go, and nothing else", async () => {
    const budget = await newBudget(admin);
    const [s1, s2, s3] = [await newSection(admin, budget), await newSection(admin, budget), await newSection(admin, budget)];
    const [c1, c2, c3, c4] = [await newCategory(admin, s1), await newCategory(admin, s1), await newCategory(admin, s2), await newCategory(admin, s3)];
    // c2 was deleted before; s3 was deleted without its category.
    expect((await admin.delete("/category", { query: { id: c2 } })).json).toEqual(SUCCESS);
    await softDelete(stack, "sections", s3);
    // Another user's section and category under this budget, which no endpoint would make.
    const foreignSection = await seedSection(stack, secondId, budget);
    const foreignCategory = await seedCategory(stack, secondId, foreignSection);
    // Another budget of the same user.
    const otherBudget = await newBudget(admin);
    const otherSection = await newSection(admin, otherBudget);
    const otherCategory = await newCategory(admin, otherSection);
    // Rows labeled with the budget and with a category of it.
    const labeled = await seedLabeledRows(stack, adminId, "budget-cascade", { budget_id: budget, category_id: c1 });

    const rows = async () => ({
      budget: await stored(BUDGET, budget),
      s1: await stored(SECTION, s1),
      s2: await stored(SECTION, s2),
      s3: await stored(SECTION, s3),
      c1: await stored(CATEGORY, c1),
      c2: await stored(CATEGORY, c2),
      c3: await stored(CATEGORY, c3),
      c4: await stored(CATEGORY, c4),
      foreignSection: await stored(SECTION, foreignSection),
      foreignCategory: await stored(CATEGORY, foreignCategory),
      otherBudget: await stored(BUDGET, otherBudget),
      otherSection: await stored(SECTION, otherSection),
      otherCategory: await stored(CATEGORY, otherCategory),
      labels: await storedLabels(stack, labeled),
    });
    const before = await rows();
    expect(before.labels).toEqual({
      account: { is_deleted: false, label_budget_id: budget },
      transaction: { is_deleted: false, label_budget_id: budget, label_category_id: c1 },
      split: { is_deleted: false, label_budget_id: budget, label_category_id: c1 },
      investment: { is_deleted: false, label_budget_id: budget, label_category_id: c1 },
      recurring: { is_deleted: false, label_budget_id: budget, label_category_id: c1 },
      rejected: [c1],
    });

    const result = await admin.delete("/budget", { query: { id: budget } });
    expect(result.status).toBe(200);
    expect(result.json).toEqual(SUCCESS);

    const after = await rows();
    const gone = (row: StoredRow) => ({ ...row, is_deleted: true, updated: expect.any(String) });
    expect(after).toEqual({
      ...before,
      budget: gone(before.budget),
      s1: gone(before.s1),
      s2: gone(before.s2),
      c1: gone(before.c1),
      c2: gone(before.c2),
      c3: gone(before.c3),
    });
    // One transaction: every row it touched carries the same time, the category deleted earlier included.
    const stamps = [after.budget, after.s1, after.s2, after.c1, after.c2, after.c3].map((row) => row.updated);
    expect(new Set(stamps).size).toBe(1);
    expect(updatedLater(after.c2, before.c2)).toBe(true);
    // The section deleted on its own earlier is not looked at, so its category stays live.
    expect(after.c4.is_deleted).toBe(false);

    const list = await listed(admin);
    const ids = (entity: Entity) => list[entity.table].map((row) => row[entity.idField]);
    expect(ids(BUDGET)).not.toContain(budget);
    expect(ids(BUDGET)).toContain(otherBudget);
    for (const id of [s1, s2, s3]) expect(ids(SECTION)).not.toContain(id);
    expect(ids(SECTION)).toContain(otherSection);
    for (const id of [c1, c2, c3]) expect(ids(CATEGORY)).not.toContain(id);
    expect(ids(CATEGORY)).toContain(c4);
    expect(ids(CATEGORY)).toContain(otherCategory);

    // Deleting it again finds no live section, and only stamps the budget.
    expect((await admin.delete("/budget", { query: { id: budget } })).json).toEqual(SUCCESS);
    const again = await rows();
    expect(again).toEqual({ ...after, budget: { ...after.budget, updated: expect.any(String) } });
    expect(updatedLater(again.budget, after.budget)).toBe(true);
  });

  test("deletes nothing of another user's: not the budget, nor what is under it", async () => {
    const budget = await newBudget(admin);
    const section = await newSection(admin, budget);
    const category = await newCategory(admin, section);
    // The caller's own section and category under that budget, which no endpoint would make.
    const ownSection = await seedSection(stack, secondId, budget);
    const ownCategory = await seedCategory(stack, secondId, ownSection);
    const strayCategory = await seedCategory(stack, adminId, ownSection);
    const rows = async () => ({
      budget: await stored(BUDGET, budget),
      section: await stored(SECTION, section),
      category: await stored(CATEGORY, category),
      ownSection: await stored(SECTION, ownSection),
      ownCategory: await stored(CATEGORY, ownCategory),
      strayCategory: await stored(CATEGORY, strayCategory),
    });
    const before = await rows();

    const result = await second.delete("/budget", { query: { id: budget } });
    expect(result.status).toBe(200);
    expect(result.json).toEqual(SUCCESS);

    // Each statement is the caller's own: their section there goes, with their category in it.
    const after = await rows();
    expect(after).toEqual({
      ...before,
      ownSection: { ...before.ownSection, is_deleted: true, updated: expect.any(String) },
      ownCategory: { ...before.ownCategory, is_deleted: true, updated: expect.any(String) },
    });
    expect(await listedOne(admin, BUDGET, budget)).toEqual(jsonOf(BUDGET, before.budget));
    expect(await listedOne(admin, SECTION, section)).toEqual(jsonOf(SECTION, before.section));
    expect(await listedOne(admin, CATEGORY, category)).toEqual(jsonOf(CATEGORY, before.category));
  });
});

describe("DELETE /section", () => {
  test("takes the section's categories with it, in one go, and nothing else", async () => {
    const budget = await newBudget(admin);
    const [section, sibling] = [await newSection(admin, budget), await newSection(admin, budget)];
    const [c1, c2, siblingCategory] = [await newCategory(admin, section), await newCategory(admin, section), await newCategory(admin, sibling)];
    expect((await admin.delete("/category", { query: { id: c2 } })).json).toEqual(SUCCESS);
    // Another user's category in this section, which no endpoint would make.
    const foreignCategory = await seedCategory(stack, secondId, section);
    const labeled = await seedLabeledRows(stack, adminId, "section-cascade", { budget_id: budget, category_id: c1 });

    const rows = async () => ({
      budget: await stored(BUDGET, budget),
      section: await stored(SECTION, section),
      sibling: await stored(SECTION, sibling),
      c1: await stored(CATEGORY, c1),
      c2: await stored(CATEGORY, c2),
      siblingCategory: await stored(CATEGORY, siblingCategory),
      foreignCategory: await stored(CATEGORY, foreignCategory),
      labels: await storedLabels(stack, labeled),
    });
    const before = await rows();

    const result = await admin.delete("/section", { query: { id: section } });
    expect(result.status).toBe(200);
    expect(result.json).toEqual(SUCCESS);

    const after = await rows();
    const gone = (row: StoredRow) => ({ ...row, is_deleted: true, updated: expect.any(String) });
    expect(after).toEqual({ ...before, section: gone(before.section), c1: gone(before.c1), c2: gone(before.c2) });
    expect(new Set([after.section, after.c1, after.c2].map((row) => row.updated)).size).toBe(1);
    expect(updatedLater(after.c2, before.c2)).toBe(true);
    expect(after.labels).toEqual({
      account: { is_deleted: false, label_budget_id: budget },
      transaction: { is_deleted: false, label_budget_id: budget, label_category_id: c1 },
      split: { is_deleted: false, label_budget_id: budget, label_category_id: c1 },
      investment: { is_deleted: false, label_budget_id: budget, label_category_id: c1 },
      recurring: { is_deleted: false, label_budget_id: budget, label_category_id: c1 },
      rejected: [c1],
    });

    const list = await listed(admin);
    expect(list.sections.map((row) => row.section_id)).not.toContain(section);
    expect(list.sections.map((row) => row.section_id)).toContain(sibling);
    expect(list.categories.map((row) => row.category_id)).not.toContain(c1);
    expect(list.categories.map((row) => row.category_id)).toContain(siblingCategory);
    expect(list.budgets.map((row) => row.budget_id)).toContain(budget);
  });

  test("deletes nothing of another user's: not the section, nor a category in it", async () => {
    const section = await newSection(admin, await newBudget(admin));
    const category = await newCategory(admin, section);
    // The caller's own category in that section, which no endpoint would make.
    const ownCategory = await seedCategory(stack, secondId, section);
    const rows = async () => ({
      section: await stored(SECTION, section),
      category: await stored(CATEGORY, category),
      ownCategory: await stored(CATEGORY, ownCategory),
    });
    const before = await rows();

    const result = await second.delete("/section", { query: { id: section } });
    expect(result.status).toBe(200);
    expect(result.json).toEqual(SUCCESS);
    expect(await rows()).toEqual({
      ...before,
      ownCategory: { ...before.ownCategory, is_deleted: true, updated: expect.any(String) },
    });
  });
});

describe("DELETE /category", () => {
  test("deletes that category alone, and leaves the rows labeled with it as they are", async () => {
    const budget = await newBudget(admin);
    const section = await newSection(admin, budget);
    const [category, sibling] = [await newCategory(admin, section), await newCategory(admin, section)];
    const labeled = await seedLabeledRows(stack, adminId, "category-delete", { budget_id: budget, category_id: category });
    const rows = async () => ({
      budget: await stored(BUDGET, budget),
      section: await stored(SECTION, section),
      category: await stored(CATEGORY, category),
      sibling: await stored(CATEGORY, sibling),
      labels: await storedLabels(stack, labeled),
    });
    const before = await rows();

    expect((await admin.delete("/category", { query: { id: category } })).json).toEqual(SUCCESS);
    const after = await rows();
    expect(after).toEqual({ ...before, category: { ...before.category, is_deleted: true, updated: expect.any(String) } });
    expect(after.labels).toEqual({
      account: { is_deleted: false, label_budget_id: budget },
      transaction: { is_deleted: false, label_budget_id: budget, label_category_id: category },
      split: { is_deleted: false, label_budget_id: budget, label_category_id: category },
      investment: { is_deleted: false, label_budget_id: budget, label_category_id: category },
      recurring: { is_deleted: false, label_budget_id: budget, label_category_id: category },
      rejected: [category],
    });
  });

  test("leaves another user's category alone", async () => {
    const category = await CATEGORY.create(admin);
    const before = await stored(CATEGORY, category);
    const result = await second.delete("/category", { query: { id: category } });
    expect(result.status).toBe(200);
    expect(result.json).toEqual(SUCCESS);
    expect(await stored(CATEGORY, category)).toEqual(before);
  });
});

describe("GET /budgets", () => {
  test("lists nothing for a user who has made nothing", async () => {
    const { client } = await freshUser("no-budgets");
    const result = await client.get("/budgets");
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "success", body: { budgets: [], sections: [], categories: [] } });
  });

  test("lists the caller's live budgets, sections and categories whole, each column set or not", async () => {
    const { client, user_id } = await freshUser("lists-budgets");
    const capacities = [{ capacity_id: "cap-1", month: 1250.5, active_from: "2026-01-01", is_synced: true }];
    const full = { name: "Set", roll_over: true, roll_over_start_date: "2026-01-05", capacities };
    const empty = { name: null, roll_over: null, roll_over_start_date: null, capacities: null, is_deleted: null };

    const b1 = await seedBudget(stack, user_id, { ...full, iso_currency_code: "EUR" });
    const b2 = await seedBudget(stack, user_id, { ...empty, iso_currency_code: null });
    const s1 = await seedSection(stack, user_id, b1, full);
    const s2 = await seedSection(stack, user_id, b1, empty);
    const c1 = await seedCategory(stack, user_id, s1, full);
    const c2 = await seedCategory(stack, user_id, s1, empty);
    // Deleted rows are left out; what is under them is listed all the same.
    const deletedBudget = await seedBudget(stack, user_id, { is_deleted: true });
    const orphanSection = await seedSection(stack, user_id, deletedBudget, { name: "Under a deleted budget" });
    const deletedSection = await seedSection(stack, user_id, b1, { is_deleted: true });
    const orphanCategory = await seedCategory(stack, user_id, deletedSection, { name: "Under a deleted section" });
    await seedCategory(stack, user_id, s1, { is_deleted: true });
    // Another user's rows are not the caller's, wherever they hang.
    const theirs = await seedBudget(stack, secondId);
    await seedCategory(stack, secondId, await seedSection(stack, secondId, theirs));
    await seedCategory(stack, secondId, await seedSection(stack, secondId, b1));
    await seedCategory(stack, secondId, s1);

    const result = await client.get<BudgetsBody>("/budgets");
    expect(result.status).toBe(200);
    expect(result.json.status).toBe("success");
    expect(Object.keys(result.body)).toEqual(["budgets", "sections", "categories"]);
    expect(byId(BUDGET, result.body.budgets)).toEqual(
      byId(BUDGET, [
        { budget_id: b1, ...full, iso_currency_code: "EUR" },
        { budget_id: b2, name: null, iso_currency_code: null, roll_over: null, capacities: null },
      ]),
    );
    expect(byId(SECTION, result.body.sections)).toEqual(
      byId(SECTION, [
        { section_id: s1, budget_id: b1, ...full },
        { section_id: s2, budget_id: b1, name: null, roll_over: null, capacities: null },
        { section_id: orphanSection, budget_id: deletedBudget, name: "Under a deleted budget", roll_over: false, capacities: [] },
      ]),
    );
    expect(byId(CATEGORY, result.body.categories)).toEqual(
      byId(CATEGORY, [
        { category_id: c1, section_id: s1, ...full },
        { category_id: c2, section_id: s1, name: null, roll_over: null, capacities: null },
        { category_id: orphanCategory, section_id: deletedSection, name: "Under a deleted section", roll_over: false, capacities: [] },
      ]),
    );
  });

  test("writes every object's keys in one order", async () => {
    const { client, user_id } = await freshUser("orders-keys");
    // JSONB keeps an object's keys by length, then by byte; JavaScript lists whole-number keys first.
    const capacities = [
      { capacity_id: "cap-1", month: 100.25, active_from: "2026-01-01", is_synced: false },
      { b: 1, "10": 2, a: { z: 1, "2": 2 } },
    ];
    const capacitiesText =
      '[{"month":100.25,"is_synced":false,"active_from":"2026-01-01","capacity_id":"cap-1"},{"10":2,"a":{"2":2,"z":1},"b":1}]';
    const family = `"name":"Ordered","roll_over":true,"roll_over_start_date":"2026-01-05","capacities":${capacitiesText}`;
    const row = { name: "Ordered", roll_over: true, roll_over_start_date: "2026-01-05", capacities };
    const budget = await seedBudget(stack, user_id, { ...row, iso_currency_code: "EUR" });
    const section = await seedSection(stack, user_id, budget, row);
    const category = await seedCategory(stack, user_id, section, { ...row, roll_over_start_date: null });

    const result = await client.get("/budgets");
    expect(result.text).toBe(
      `{"status":"success","body":{"budgets":[{"budget_id":"${budget}","name":"Ordered","iso_currency_code":"EUR",` +
        `"roll_over":true,"roll_over_start_date":"2026-01-05","capacities":${capacitiesText}}],` +
        `"sections":[{"section_id":"${section}","budget_id":"${budget}",${family}}],` +
        `"categories":[{"category_id":"${category}","section_id":"${section}","name":"Ordered","roll_over":true,"capacities":${capacitiesText}}]}}`,
    );
    expect(result.headers.get("content-type")).toBe("application/json");
  });

  test("fails as a server error while a row's capacities are stored as anything but a list", async () => {
    const { client, user_id } = await freshUser("broken-capacities");
    const budget = await seedBudget(stack, user_id);
    const section = await seedSection(stack, user_id, budget);
    const category = await seedCategory(stack, user_id, section);
    const route = "GET /budgets";
    expect(alarmsFor(route)).toHaveLength(0);

    const broken: [string, string, string][] = [
      ["budgets", budget, '{"a":1}'],
      ["sections", section, '"text"'],
      ["categories", category, "5"],
      ["budgets", budget, "true"],
    ];
    for (const [table, id, json] of broken) {
      await setJsonb(stack, table, id, "capacities", json);
      const result = await client.get("/budgets");
      expect([table, json, result.status, result.json]).toEqual([table, json, 500, SERVER_ERROR]);
      if (table === "budgets" && json === '{"a":1}') {
        await stack.waitFor(() => alarmsFor(route).length > 0, { what: `the ${route} alarm` });
        expect(alarmsFor(route)[0].description).toBe('**Error:** BudgetModel validation failed:\ncapacities: {"a":1} (object)');
        await stack.waitForLog('Route handler error {"method":"GET","path":"/budgets"}');
      }
      // Everyone else's list is unaffected.
      expect((await admin.get("/budgets")).status).toBe(200);
      await setJsonb(stack, table, id, "capacities", "[]");
    }

    const mended = await client.get<BudgetsBody>("/budgets");
    expect(mended.status).toBe(200);
    expect(mended.body.budgets).toHaveLength(1);
    expect(alarmsFor(route)).toHaveLength(1);
  });
});

describe("a second user", () => {
  test("sees none of the first user's budgets, sections or categories, and the first none of theirs", async () => {
    const mine = { budget: await newBudget(admin), section: "", category: "" };
    mine.section = await newSection(admin, mine.budget);
    mine.category = await newCategory(admin, mine.section);
    const theirs = { budget: await newBudget(second), section: "", category: "" };
    theirs.section = await newSection(second, theirs.budget);
    theirs.category = await newCategory(second, theirs.section);

    const [adminList, secondList] = [await listed(admin), await listed(second)];
    const ids = (list: BudgetsBody) => ({
      budgets: list.budgets.map((row) => row.budget_id),
      sections: list.sections.map((row) => row.section_id),
      categories: list.categories.map((row) => row.category_id),
    });
    for (const [list, own, foreign, owner] of [
      [ids(adminList), mine, theirs, adminId],
      [ids(secondList), theirs, mine, secondId],
    ] as const) {
      expect(list.budgets).toContain(own.budget);
      expect(list.sections).toContain(own.section);
      expect(list.categories).toContain(own.category);
      expect(list.budgets).not.toContain(foreign.budget);
      expect(list.sections).not.toContain(foreign.section);
      expect(list.categories).not.toContain(foreign.category);
      // Everything listed is stored as the caller's own.
      for (const entity of ENTITIES) {
        const owned = (await storedRows(stack, entity.table, { user_id: owner })).map((row) => row[entity.idField]);
        for (const id of list[entity.table]) expect(owned).toContain(id);
      }
    }
  });

  test("changes and deletes none of the first user's rows, by any route", async () => {
    const budget = await newBudget(admin);
    const section = await newSection(admin, budget);
    const category = await newCategory(admin, section);
    const rows = async () => ({
      budget: await stored(BUDGET, budget),
      section: await stored(SECTION, section),
      category: await stored(CATEGORY, category),
      sections: (await storedRows(stack, "sections", { budget_id: budget })).length,
      categories: (await storedRows(stack, "categories", { section_id: section })).length,
    });
    const before = await rows();

    const attempts: [string, string, unknown?, string?][] = [
      ["POST", "/budget", { budget_id: budget, name: "Theirs now", iso_currency_code: "EUR", roll_over: true, capacities: [1] }],
      ["POST", "/section", { section_id: section, name: "Theirs now", roll_over: true, capacities: [1] }],
      ["POST", "/category", { category_id: category, name: "Theirs now", roll_over: true, capacities: [1] }],
      ["DELETE", `/category?id=${category}`],
      ["DELETE", `/section?id=${section}`],
      ["DELETE", `/budget?id=${budget}`],
      ["GET", `/new-section?parent=${budget}`, undefined, "Failed to create section."],
      ["GET", `/new-category?parent=${section}`, undefined, "Failed to create category."],
    ];
    for (const [method, path, body, refusal] of attempts) {
      const result = await second.request(method, path, { body });
      expect([method, path, result.status]).toEqual([method, path, 200]);
      // A write to a row that is not the caller's answers like one that matched no row.
      expect(result.json).toEqual(refusal ? failed(refusal) : SUCCESS);
      expect(await rows()).toEqual(before);
    }
  });
});
