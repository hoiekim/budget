/**
 * The recurring routes: `GET /recurrings`, `POST /recurrings` (create one from
 * transactions; or, on an existing one, add transactions, rename it, set its
 * splits or default label, or confirm it) and `DELETE /recurrings` (dismiss
 * it). Recurrings are shared within a sharing group; a request on someone
 * else's is carried out as its owner. A confirmed recurring labels and splits
 * its transactions, which the tests read back from the database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, startStack, type ApiClient, type Stack } from "../harness";
import { seedApiKey, seedBudget, seedCategory, seedSection } from "../harness/seed/budgets";
import {
  NO_SUCH_UUID,
  TIMESTAMP,
  UUID,
  localDay,
  pick,
  seedRecurring,
  seedTransaction,
  shareData,
  stored,
  storedLabels,
  storedOne,
  storedSplits,
  transactionJson,
  type SeedTransaction,
} from "../harness/seed/transfers";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

const SUCCESS = { status: "success" };
const SERVER_ERROR = { status: "error", message: "Internal server error" };
const failed = (message: string) => ({ status: "failed", message });
const NOT_FOUND = failed("Recurring not found.");
const TRANSACTIONS_GONE = failed("One or more transactions no longer exist (deleted or never belonged to this user).");
const IN_ANOTHER = failed("One of these transactions is already in another recurring. Remove it from the existing recurring first.");
const NOT_ONE_GROUP = failed("Those transactions don't form a single recurring group (same merchant and direction).");

const alarmsFor = (route: string) =>
  stack.upstream.discord.alarms().filter((alarm) => alarm.title === `🚨 Budget Server Error: Route Error: ${route}`);

interface Person {
  id: string;
  tag: string;
  client: ApiClient;
}

let counter = 0;
/** A fresh user, signed in. Each test makes its own, so nothing leaks between tests. */
const person = async (name: string): Promise<Person> => {
  const tag = `${name}${++counter}`;
  const user = await createUser(stack, tag);
  return { id: user.user_id, tag, client: await stack.login(tag, user.password) };
};

/** A Netflix charge of `p` unless told otherwise, its id `<tag>-<suffix>`. */
const tx = (p: Person, suffix: string, extra: Partial<SeedTransaction> = {}): Promise<SeedTransaction> =>
  seedTransaction(stack, p.id, {
    transaction_id: `${p.tag}-${suffix}`,
    account_id: `${p.tag}-checking`,
    amount: 15.99,
    date: "2026-03-15",
    merchant_name: "Netflix",
    ...extra,
  });

interface Label {
  budget_id: string | null;
  category_id: string | null;
}

/** A budget and a category in it, both `p`'s. */
const label = async (p: Person): Promise<Label> => {
  const budget_id = await seedBudget(stack, p.id);
  const section_id = await seedSection(stack, p.id, budget_id);
  return { budget_id, category_id: await seedCategory(stack, p.id, section_id) };
};

/** The label columns a transaction holds after taking `l` as a confirmed label. */
const labeled = (t: SeedTransaction, l: Label, confidence = l.category_id ? 1 : 0): SeedTransaction => ({
  ...t,
  label_budget_id: l.budget_id,
  label_category_id: l.category_id,
  label_category_confidence: confidence,
});

const EMPTY_LABEL: Label = { budget_id: null, category_id: null };

/** A recurring as the routes answer with it. */
const listed = (
  recurring_id: string,
  fields: {
    merchant_key?: string;
    merchant_name?: string;
    cadence?: string;
    is_income?: boolean;
    status?: string;
    label?: Label;
    splits?: unknown[];
  },
  transactions: SeedTransaction[],
) => ({
  recurring_id,
  merchant_key: fields.merchant_key ?? "seeded merchant",
  merchant_name: fields.merchant_name ?? "Seeded Merchant",
  cadence: fields.cadence ?? "monthly",
  is_income: fields.is_income ?? false,
  status: fields.status ?? "suggested",
  transactions: transactions.map(transactionJson),
  label: fields.label ?? EMPTY_LABEL,
  splits: fields.splits ?? [],
  updated: expect.stringMatching(TIMESTAMP),
});

/** What `POST /recurrings` answers when it creates or adds to a recurring. */
type RecurringAnswer = { recurring_id: string; recurring: { transactions: { transaction_id: string }[] } };

const byId = <T extends { recurring_id: string }>(list: T[]): T[] => [...list].sort((a, b) => (a.recurring_id < b.recurring_id ? -1 : 1));

const RECURRING_COLUMNS = [
  "user_id",
  "merchant_key",
  "merchant_name",
  "cadence",
  "is_income",
  "status",
  "transaction_ids",
  "label_budget_id",
  "label_category_id",
  "splits",
  "splits_since",
  "is_deleted",
];
const recurringRow = async (recurring_id: string) => pick(await storedOne(stack, "recurrings", recurring_id), RECURRING_COLUMNS);
const recurringsOf = async (user_id: string) =>
  (await stored(stack, "recurrings", { user_id }, "t.merchant_key, t.is_income")).map((row) => pick(row, ["recurring_id", ...RECURRING_COLUMNS]));

/** What `storedLabels` reads for each of `transactions`, in id order. */
const labelsOf = (transactions: SeedTransaction[]) =>
  [...transactions]
    .sort((a, b) => (a.transaction_id < b.transaction_id ? -1 : 1))
    .map((t) => ({
      transaction_id: t.transaction_id,
      label_budget_id: t.label_budget_id ?? null,
      label_category_id: t.label_category_id ?? null,
      label_category_confidence: t.label_category_confidence ?? null,
    }));
const ids = (transactions: SeedTransaction[]) => transactions.map((t) => t.transaction_id);

describe("the recurring routes refuse anonymous callers", () => {
  const requests: [string, string, unknown?][] = [
    ["GET", "/recurrings"],
    ["POST", "/recurrings", { transaction_ids: ["a"] }],
    ["DELETE", `/recurrings?id=${NO_SUCH_UUID}`],
  ];

  test("every one of them", async () => {
    for (const [method, path, body] of requests) {
      const result = await stack.anonymous().request(method, path, { body });
      expect([method, path, result.status, result.json]).toEqual([method, path, 401, failed("Not authenticated.")]);
    }
  });

  test("and callers with only an API key", async () => {
    const owner = await person("keyed");
    const key = await seedApiKey(stack, owner.id, ["transactions:suggest", "budgets:read", "budgets:write"]);
    for (const [method, path, body] of requests) {
      const result = await stack.anonymous().request(method, path, {
        body,
        headers: { Authorization: `Bearer ${key}`, "X-Real-IP": "10.53.0.1" },
      });
      expect([method, path, result.status, result.json]).toEqual([method, path, 401, failed("Not authenticated.")]);
    }
  });
});

describe("GET /recurrings", () => {
  test("answers an empty list to someone with no recurrings", async () => {
    const alice = await person("alice");
    const result = await alice.client.get("/recurrings");
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "success", body: [] });
  });

  test("lists live recurrings in id order with their live members inline, and evicts the rest only when asked", async () => {
    const [alice, stranger] = [await person("alice"), await person("stranger")];
    const l = await label(alice);
    const [a, b, c] = [await tx(alice, "a", { date: "2026-01-15" }), await tx(alice, "b", { date: "2026-02-15" }), await tx(alice, "c")];
    const gone = await tx(alice, "gone", { is_deleted: true });
    const theirs = await tx(stranger, "x");
    const pay = await tx(alice, "pay", { amount: -2500, merchant_name: "Employer", name: null });
    const splits = [{ amount: 5, label: { budget_id: l.budget_id, category_id: null } }];
    const bill = await seedRecurring(stack, alice.id, {
      merchant_key: "netflix",
      merchant_name: "Netflix",
      status: "confirmed",
      transaction_ids: [c.transaction_id, gone.transaction_id, theirs.transaction_id, a.transaction_id, b.transaction_id],
      label_budget_id: l.budget_id,
      label_category_id: l.category_id,
      splits,
      splits_since: "2026-01-01",
    });
    const income = await seedRecurring(stack, alice.id, { merchant_key: "employer", merchant_name: "Employer", cadence: "biweekly", is_income: true, transaction_ids: [pay.transaction_id] });
    const dismissed = await seedRecurring(stack, alice.id, { merchant_key: "dismissed", status: "dismissed", transaction_ids: [a.transaction_id] });
    const deleted = await seedRecurring(stack, alice.id, { merchant_key: "deleted", status: "confirmed", is_deleted: true, transaction_ids: [b.transaction_id] });
    const ghost = await seedRecurring(stack, alice.id, { merchant_key: "ghost", transaction_ids: [gone.transaction_id, theirs.transaction_id] });
    const empty = await seedRecurring(stack, alice.id, { merchant_key: "empty" });

    const visible = byId([
      listed(bill, { merchant_key: "netflix", merchant_name: "Netflix", status: "confirmed", label: l, splits }, [c, a, b]),
      listed(income, { merchant_key: "employer", merchant_name: "Employer", cadence: "biweekly", is_income: true }, [pay]),
    ]);
    for (const query of [undefined, { "include-deleted": "false" }, { "include-deleted": "True" }, { "include-deleted": "" }]) {
      expect([query, (await alice.client.get("/recurrings", { query })).json]).toEqual([query, { status: "success", body: visible }]);
    }

    const result = await alice.client.get("/recurrings", { query: { "include-deleted": "true" } });
    expect(result.json).toEqual({
      status: "success",
      body: [
        ...visible,
        ...byId([
          listed(dismissed, { merchant_key: "dismissed", status: "dismissed" }, []),
          listed(deleted, { merchant_key: "deleted", status: "confirmed" }, []),
        ]),
        ...byId([listed(ghost, { merchant_key: "ghost" }, []), listed(empty, { merchant_key: "empty" }, [])]),
      ],
    });
  });

  test("refuses a repeated include-deleted or start-date", async () => {
    const alice = await person("alice");
    for (const [query, message] of [
      ["include-deleted=true&include-deleted=false", "Parameter include-deleted must be a single value, not an array"],
      ["start-date=2026-01-01&start-date=", "Parameter start-date must be a single value, not an array"],
    ]) {
      expect([query, (await alice.client.get(`/recurrings?${query}`)).json]).toEqual([query, failed(message)]);
    }
  });

  test("with start-date, answers only the recurrings updated since then", async () => {
    const alice = await person("alice");
    const [a, b, c] = [await tx(alice, "a"), await tx(alice, "b"), await tx(alice, "c")];
    const old = await seedRecurring(stack, alice.id, { merchant_key: "old", transaction_ids: [a.transaction_id], updated: "2020-01-01T00:00:00Z" });
    const mid = await seedRecurring(stack, alice.id, { merchant_key: "mid", transaction_ids: [b.transaction_id], updated: "2024-06-01T12:00:00Z" });
    const fresh = await seedRecurring(stack, alice.id, { merchant_key: "fresh", transaction_ids: [c.transaction_id] });
    const oldDismissed = await seedRecurring(stack, alice.id, { merchant_key: "gone", status: "dismissed", updated: "2020-01-01T00:00:00Z" });
    const freshDismissed = await seedRecurring(stack, alice.id, { merchant_key: "gone2", status: "dismissed" });
    const [oldOne, midOne, freshOne] = [
      listed(old, { merchant_key: "old" }, [a]),
      listed(mid, { merchant_key: "mid" }, [b]),
      listed(fresh, { merchant_key: "fresh" }, [c]),
    ];
    for (const [start, expected] of [
      ["", byId([oldOne, midOne, freshOne])],
      ["2024-01-01", byId([midOne, freshOne])],
      ["2024-06-01T12:00:00Z", byId([midOne, freshOne])],
      ["2024-06-01T12:00:00.001Z", [freshOne]],
      ["9999-12-31", []],
    ] as const) {
      expect([start, (await alice.client.get("/recurrings", { query: { "start-date": start } })).json]).toEqual([start, { status: "success", body: expected }]);
    }
    const withEvictions = await alice.client.get("/recurrings", { query: { "start-date": "2024-01-01", "include-deleted": "true" } });
    expect(withEvictions.body).toEqual([...byId([midOne, freshOne]), listed(freshDismissed, { merchant_key: "gone2", status: "dismissed" }, [])]);
    expect(oldDismissed).toMatch(UUID);
  });

  test("fails as a server error on a start-date the database will not read, and alarms", async () => {
    const alice = await person("alice");
    await seedRecurring(stack, alice.id, { merchant_key: "any" });
    const route = "GET /recurrings";
    expect(alarmsFor(route)).toHaveLength(0);
    const result = await alice.client.get("/recurrings", { query: { "start-date": "garbage" } });
    expect([result.status, result.json]).toEqual([500, SERVER_ERROR]);
    await stack.waitFor(() => alarmsFor(route).length > 0, { what: `the ${route} alarm` });
    expect(alarmsFor(route)[0].description).toBe('**Error:** invalid input syntax for type timestamp with time zone: "garbage"');
    // Within the alarm's cooldown, a second failure answers the same and sends nothing more.
    const again = await alice.client.get("/recurrings", { query: { "start-date": "2026-02-30" } });
    expect([again.status, again.json]).toEqual([500, SERVER_ERROR]);
    await stack.waitForLog('Route handler error {"method":"GET","path":"/recurrings"}', { count: 2 });
    expect(alarmsFor(route)).toHaveLength(1);
  });

  test("includes the recurrings of everyone sharing data with the caller, and no one else's", async () => {
    const [alice, bob, carol] = [await person("alice"), await person("bob"), await person("carol")];
    await shareData(stack, alice.id, bob.id);
    const [a, b, c] = [await tx(alice, "a"), await tx(bob, "b"), await tx(carol, "c")];
    const alices = await seedRecurring(stack, alice.id, { merchant_key: "a", transaction_ids: [a.transaction_id, b.transaction_id] });
    const bobs = await seedRecurring(stack, bob.id, { merchant_key: "b", transaction_ids: [b.transaction_id, c.transaction_id] });
    const carols = await seedRecurring(stack, carol.id, { merchant_key: "c", transaction_ids: [c.transaction_id, a.transaction_id] });
    const shared = byId([listed(alices, { merchant_key: "a" }, [a, b]), listed(bobs, { merchant_key: "b" }, [b])]);
    expect((await alice.client.get("/recurrings")).body).toEqual(shared);
    expect((await bob.client.get("/recurrings")).body).toEqual(shared);
    expect((await carol.client.get("/recurrings")).body).toEqual([listed(carols, { merchant_key: "c" }, [c])]);
  });
});

describe("POST /recurrings: the body", () => {
  test("refuses a body that is not an object", async () => {
    const alice = await person("alice");
    for (const [body, message] of [
      [undefined, "Request body is required"],
      [null, "Request body is required"],
      [[], "Request body must be an object"],
      ["text", "Request body must be an object"],
      [7, "Request body must be an object"],
    ] as const) {
      expect([body, (await alice.client.post("/recurrings", body)).json]).toEqual([body, failed(message)]);
    }
  });

  test("fails as a server error, and alarms, on a recurring_id that is not a UUID", async () => {
    const alice = await person("alice");
    const route = "POST /recurrings";
    expect(alarmsFor(route)).toHaveLength(0);
    const result = await alice.client.post("/recurrings", { recurring_id: "not-a-uuid", merchant_name: "x" });
    expect([result.status, result.json]).toEqual([500, SERVER_ERROR]);
    await stack.waitFor(() => alarmsFor(route).length > 0, { what: `the ${route} alarm` });
    expect(alarmsFor(route)[0].description).toBe('**Error:** invalid input syntax for type uuid: "not-a-uuid"');
  });
});

describe("POST /recurrings with recurring_id alone: confirm", () => {
  test("confirms, seeds the default label from the members, relabels those that follow it, and answers with the recurring", async () => {
    const alice = await person("alice");
    const [x, y, z] = [await label(alice), await label(alice), await label(alice)];
    const other = await label(alice);
    const m1 = await tx(alice, "m1", { date: "2026-01-15", ...pickLabel(x, 1) });
    const m2 = await tx(alice, "m2", { date: "2026-02-15", ...pickLabel(x, 1) });
    const m3 = await tx(alice, "m3", { date: "2026-03-15", ...pickLabel(y, 1) });
    const m4 = await tx(alice, "m4", { date: "2026-04-15" });
    const m5 = await tx(alice, "m5", { date: "2026-05-15", ...pickLabel(z, 0.4) });
    const m6 = await tx(alice, "m6", { date: "2026-06-15", label_budget_id: other.budget_id, label_category_confidence: 0 });
    const m7 = await tx(alice, "m7", { date: "2026-07-15", label_category_confidence: 0 });
    const gone = await tx(alice, "gone", { date: "2026-08-15", is_deleted: true });
    const members = [m1, m2, m3, m4, m5, m6, m7];
    const id = await seedRecurring(stack, alice.id, { merchant_key: "netflix", merchant_name: "Netflix", transaction_ids: [...ids(members), gone.transaction_id] });

    const result = await alice.client.post("/recurrings", { recurring_id: id });
    const after = [m1, m2, m3, labeled(m4, x), labeled(m5, x), m6, labeled(m7, x)];
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      status: "success",
      body: { recurring_id: id, recurring: listed(id, { merchant_key: "netflix", merchant_name: "Netflix", status: "confirmed", label: x }, after) },
    });
    expect(pick(await recurringRow(id), ["status", "label_budget_id", "label_category_id"])).toEqual({ status: "confirmed", label_budget_id: x.budget_id, label_category_id: x.category_id });
    expect(await storedLabels(stack, ids(members))).toEqual(labelsOf(after));
  });

  test("with a stored default, relabels the members that follow it", async () => {
    const alice = await person("alice");
    const [x, budgetOnly] = [await label(alice), await label(alice)];
    const m1 = await tx(alice, "m1", { ...pickLabel(budgetOnly, 1) });
    const m2 = await tx(alice, "m2", { label_category_confidence: 0.9, label_budget_id: x.budget_id, label_category_id: x.category_id });
    const id = await seedRecurring(stack, alice.id, {
      transaction_ids: ids([m1, m2]),
      label_budget_id: budgetOnly.budget_id,
      label_category_id: null,
    });
    const result = await alice.client.post<{ recurring: { label: Label } }>("/recurrings", { recurring_id: id });
    expect(result.body.recurring.label).toEqual({ budget_id: budgetOnly.budget_id, category_id: null });
    // A budget-only default leaves the category empty on purpose: confidence 0.
    const budgetLabel = { budget_id: budgetOnly.budget_id, category_id: null };
    expect(await storedLabels(stack, ids([m1, m2]))).toEqual(labelsOf([m1, labeled(m2, budgetLabel)]));
  });

  test("relabels nothing when no member has a confirmed label to start from", async () => {
    const alice = await person("alice");
    const x = await label(alice);
    const m1 = await tx(alice, "m1", { ...pickLabel(x, 0.5) });
    const m2 = await tx(alice, "m2");
    const id = await seedRecurring(stack, alice.id, { transaction_ids: ids([m1, m2]) });
    expect((await alice.client.post("/recurrings", { recurring_id: id })).json).toEqual({
      status: "success",
      body: { recurring_id: id, recurring: listed(id, { status: "confirmed" }, [m1, m2]) },
    });
    expect(await storedLabels(stack, ids([m1, m2]))).toEqual(labelsOf([m1, m2]));
  });

  test("confirms a dismissed recurring again, and one with no live members, which then has nothing to answer with", async () => {
    const alice = await person("alice");
    const [a, gone] = [await tx(alice, "a"), await tx(alice, "gone", { is_deleted: true })];
    const dismissed = await seedRecurring(stack, alice.id, { merchant_key: "d", status: "dismissed", transaction_ids: [a.transaction_id] });
    const ghost = await seedRecurring(stack, alice.id, { merchant_key: "g", transaction_ids: [gone.transaction_id] });
    expect((await alice.client.post("/recurrings", { recurring_id: dismissed })).json).toEqual({
      status: "success",
      body: { recurring_id: dismissed, recurring: listed(dismissed, { merchant_key: "d", status: "confirmed" }, [a]) },
    });
    expect((await alice.client.post("/recurrings", { recurring_id: ghost })).json).toEqual({ status: "success", body: { recurring_id: ghost } });
    expect((await recurringRow(ghost))!.status).toBe("confirmed");
  });

  test("answers 'Recurring not found.' for a missing, deleted or stranger's recurring", async () => {
    const [alice, stranger] = [await person("alice"), await person("stranger")];
    const deleted = await seedRecurring(stack, alice.id, { is_deleted: true });
    const theirs = await seedRecurring(stack, stranger.id);
    for (const recurring_id of [NO_SUCH_UUID, deleted, theirs]) {
      expect((await alice.client.post("/recurrings", { recurring_id })).json).toEqual(NOT_FOUND);
    }
    expect((await recurringRow(deleted))!.status).toBe("suggested");
    expect((await recurringRow(theirs))!.status).toBe("suggested");
  });

  test("confirms a recurring of someone sharing data with the caller, as its owner", async () => {
    const [alice, bob] = [await person("alice"), await person("bob")];
    await shareData(stack, alice.id, bob.id);
    const x = await label(bob);
    const b1 = await tx(bob, "b1", { ...pickLabel(x, 1) });
    const b2 = await tx(bob, "b2");
    const id = await seedRecurring(stack, bob.id, { transaction_ids: ids([b1, b2]) });
    expect((await alice.client.post("/recurrings", { recurring_id: id })).json).toEqual({
      status: "success",
      body: { recurring_id: id, recurring: listed(id, { status: "confirmed", label: x }, [b1, labeled(b2, x)]) },
    });
    expect(pick(await recurringRow(id), ["user_id", "status"])).toEqual({ user_id: bob.id, status: "confirmed" });
  });
});

/** The label columns of a transaction holding `l` with `confidence`. */
function pickLabel(l: Label, confidence: number): Partial<SeedTransaction> {
  return { label_budget_id: l.budget_id, label_category_id: l.category_id, label_category_confidence: confidence };
}

describe("POST /recurrings with merchant_name: rename", () => {
  test("refuses a name that is not a non-empty string once trimmed", async () => {
    const alice = await person("alice");
    const id = await seedRecurring(stack, alice.id);
    for (const merchant_name of ["", "   ", "\t\n", null, 5, false, ["x"], {}]) {
      expect([merchant_name, (await alice.client.post("/recurrings", { recurring_id: id, merchant_name, splits: [] })).json]).toEqual([
        merchant_name,
        failed("merchant_name must be a non-empty string"),
      ]);
    }
    expect((await recurringRow(id))!.merchant_name).toBe("Seeded Merchant");
  });

  test("renames, trimmed, and answers with the id alone; a dismissed one too", async () => {
    const alice = await person("alice");
    const id = await seedRecurring(stack, alice.id);
    const dismissed = await seedRecurring(stack, alice.id, { merchant_key: "d", status: "dismissed" });
    expect((await alice.client.post("/recurrings", { recurring_id: id, merchant_name: "  My bill ", label: 5 })).json).toEqual({
      status: "success",
      body: { recurring_id: id },
    });
    expect(pick(await recurringRow(id), ["merchant_key", "merchant_name"])).toEqual({ merchant_key: "seeded merchant", merchant_name: "My bill" });
    expect((await alice.client.post("/recurrings", { recurring_id: dismissed, merchant_name: "Gone" })).json).toEqual({ status: "success", body: { recurring_id: dismissed } });
    expect(pick(await recurringRow(dismissed), ["status", "merchant_name"])).toEqual({ status: "dismissed", merchant_name: "Gone" });
  });

  test("answers 'Recurring not found.' for a missing, deleted or stranger's recurring, and renames a group member's", async () => {
    const [alice, bob, stranger] = [await person("alice"), await person("bob"), await person("stranger")];
    await shareData(stack, alice.id, bob.id);
    const deleted = await seedRecurring(stack, alice.id, { is_deleted: true });
    const theirs = await seedRecurring(stack, stranger.id);
    for (const recurring_id of [NO_SUCH_UUID, deleted, theirs]) {
      expect((await alice.client.post("/recurrings", { recurring_id, merchant_name: "x" })).json).toEqual(NOT_FOUND);
    }
    const bobs = await seedRecurring(stack, bob.id);
    expect((await alice.client.post("/recurrings", { recurring_id: bobs, merchant_name: "Bob's" })).json).toEqual({ status: "success", body: { recurring_id: bobs } });
    expect(pick(await recurringRow(bobs), ["user_id", "merchant_name"])).toEqual({ user_id: bob.id, merchant_name: "Bob's" });
    expect((await recurringRow(theirs))!.merchant_name).toBe("Seeded Merchant");
  });
});

describe("POST /recurrings with splits", () => {
  test("refuses splits that are not an array of at most twenty objects with a positive amount and UUID labels", async () => {
    const alice = await person("alice");
    const id = await seedRecurring(stack, alice.id);
    const one = { amount: 1 };
    for (const [splits, message] of [
      [null, "splits must be an array"],
      [{ amount: 1 }, "splits must be an array"],
      ["[]", "splits must be an array"],
      [Array(21).fill(one), "A recurring can have at most 20 splits"],
      [[null], "Each split must be an object"],
      [[one, 0], "Each split must be an object"],
      [[""], "Each split must be an object"],
      [["split"], "Each split must be an object"],
      [[true], "Each split must be an object"],
      [[false], "Each split must be an object"],
      [[[]], "Field amount must be an object"],
      [[[1]], "Field amount must be an object"],
      [[{}], "Missing required field: amount"],
      [[{ amount: null }], "Field amount must be a number"],
      [[{ amount: "5" }], "Field amount must be a number"],
      [[{ amount: 0 }], "Each split amount must be positive"],
      [[{ amount: 0.004 }], "Each split amount must be positive"],
      [[{ amount: -2 }], "Each split amount must be positive"],
      [[{ amount: 1, label: 5 }], "Field label must be an object"],
      [[{ amount: 1, label: "x" }], "Field label must be an object"],
      [[{ amount: 1, label: [] }], "Field label must be an object"],
      [[{ amount: 1, label: { budget_id: "x" } }], "Field label.budget_id must be a uuid"],
      [[{ amount: 1, label: { budget_id: 5, category_id: "y" } }], "Field label.budget_id must be a uuid"],
      [[{ amount: 1, label: { category_id: "" } }], "Field label.category_id must be a uuid"],
    ] as const) {
      const result = await alice.client.post("/recurrings", { recurring_id: id, splits, label: {} });
      expect([splits, result.json]).toEqual([splits, failed(message)]);
    }
    expect(pick(await recurringRow(id), ["splits", "splits_since"])).toEqual({ splits: [], splits_since: null });
  });

  test("stores them rounded to cents, from today, and answers with the recurring; an empty list clears them", async () => {
    const alice = await person("alice");
    const l = await label(alice);
    const deletedBudget = await seedBudget(stack, alice.id, { is_deleted: true });
    const m = await tx(alice, "m");
    const id = await seedRecurring(stack, alice.id, { status: "confirmed", transaction_ids: [m.transaction_id] });
    const splits = [
      { amount: 12.345 },
      { amount: 0.005, label: { budget_id: l.budget_id } },
      { amount: 3, label: { budget_id: l.budget_id, category_id: l.category_id } },
      { amount: 4, label: null },
      { amount: 2.5, label: { budget_id: deletedBudget, category_id: null } },
      ...Array(15).fill({ amount: 1 }),
    ];
    const expected = [
      { amount: 12.35, label: EMPTY_LABEL },
      { amount: 0.01, label: { budget_id: l.budget_id, category_id: null } },
      { amount: 3, label: l },
      { amount: 4, label: EMPTY_LABEL },
      { amount: 2.5, label: { budget_id: deletedBudget, category_id: null } },
      ...Array(15).fill({ amount: 1, label: EMPTY_LABEL }),
    ];
    const result = await alice.client.post("/recurrings", { recurring_id: id, splits, label: { budget_id: l.budget_id } });
    expect(result.json).toEqual({ status: "success", body: { recurring_id: id, recurring: listed(id, { status: "confirmed", splits: expected }, [m]) } });
    expect(pick(await recurringRow(id), ["splits", "splits_since", "label_budget_id"])).toEqual({ splits: expected, splits_since: localDay(0), label_budget_id: null });
    // Setting splits splits nothing already there.
    expect(await storedSplits(stack, [m.transaction_id])).toEqual([]);

    expect((await alice.client.post("/recurrings", { recurring_id: id, splits: [] })).json).toEqual({
      status: "success",
      body: { recurring_id: id, recurring: listed(id, { status: "confirmed" }, [m]) },
    });
    expect(pick(await recurringRow(id), ["splits", "splits_since"])).toEqual({ splits: [], splits_since: localDay(0) });
  });

  test("refuses a label that is not the user's, and a recurring that is missing, deleted or a stranger's", async () => {
    const [alice, stranger] = [await person("alice"), await person("stranger")];
    const [mine, theirs] = [await label(alice), await label(stranger)];
    const id = await seedRecurring(stack, alice.id);
    const notFound = failed("A split's budget or category was not found.");
    for (const splitLabel of [
      { budget_id: theirs.budget_id },
      { budget_id: mine.budget_id, category_id: theirs.category_id },
      { category_id: NO_SUCH_UUID },
      // The lookup finds a capitalised id, whose answer is written in lower case.
      { budget_id: mine.budget_id!.toUpperCase() },
    ]) {
      expect((await alice.client.post("/recurrings", { recurring_id: id, splits: [{ amount: 1 }, { amount: 2, label: splitLabel }] })).json).toEqual(notFound);
    }
    expect(pick(await recurringRow(id), ["splits", "splits_since"])).toEqual({ splits: [], splits_since: null });

    const deleted = await seedRecurring(stack, alice.id, { merchant_key: "deleted", is_deleted: true });
    const strangers = await seedRecurring(stack, stranger.id);
    for (const recurring_id of [NO_SUCH_UUID, deleted, strangers]) {
      expect((await alice.client.post("/recurrings", { recurring_id, splits: [{ amount: 1, label: { budget_id: mine.budget_id } }] })).json).toEqual(NOT_FOUND);
    }
  });
});

describe("POST /recurrings with label: the default label", () => {
  test("refuses a label that is not an object of UUIDs", async () => {
    const alice = await person("alice");
    const id = await seedRecurring(stack, alice.id);
    for (const [l, message] of [
      ["x", "Field label must be an object"],
      ["", "Field label must be an object"],
      [5, "Field label must be an object"],
      [0, "Field label must be an object"],
      [false, "Field label must be an object"],
      [[], "Field label must be an object"],
      [null, "label must be an object"],
      [{ budget_id: "x" }, "Field label.budget_id must be a uuid"],
      [{ budget_id: 5, category_id: "x" }, "Field label.budget_id must be a uuid"],
      [{ category_id: true }, "Field label.category_id must be a uuid"],
    ] as const) {
      expect([l, (await alice.client.post("/recurrings", { recurring_id: id, label: l })).json]).toEqual([l, failed(message)]);
    }
  });

  test("on a suggested recurring, stores it and relabels nothing until it is confirmed", async () => {
    const alice = await person("alice");
    const x = await label(alice);
    const m = await tx(alice, "m");
    const id = await seedRecurring(stack, alice.id, { transaction_ids: [m.transaction_id] });
    const result = await alice.client.post("/recurrings", { recurring_id: id, label: { category_id: x.category_id } });
    expect(result.json).toEqual({
      status: "success",
      body: { recurring_id: id, recurring: listed(id, { label: { budget_id: null, category_id: x.category_id } }, [m]) },
    });
    expect(await storedLabels(stack, [m.transaction_id])).toEqual(labelsOf([m]));
  });

  test("on a confirmed recurring, moves the members that followed the old default, and leaves the exceptions", async () => {
    const alice = await person("alice");
    const [old, other, next] = [await label(alice), await label(alice), await label(alice)];
    const follows = await tx(alice, "a", { ...pickLabel(old, 1) });
    const exception = await tx(alice, "b", { ...pickLabel(other, 1) });
    const unlabeled = await tx(alice, "c");
    const budgetOnlyOld = await tx(alice, "d", { label_budget_id: old.budget_id, label_category_confidence: 0 });
    const budgetOnlyOther = await tx(alice, "e", { label_budget_id: other.budget_id, label_category_confidence: 0 });
    const members = [follows, exception, unlabeled, budgetOnlyOld, budgetOnlyOther];
    const id = await seedRecurring(stack, alice.id, { status: "confirmed", transaction_ids: ids(members), label_budget_id: old.budget_id, label_category_id: old.category_id });
    const result = await alice.client.post("/recurrings", { recurring_id: id, label: next });
    const after = [labeled(follows, next), exception, labeled(unlabeled, next), labeled(budgetOnlyOld, next), budgetOnlyOther];
    expect(result.json).toEqual({ status: "success", body: { recurring_id: id, recurring: listed(id, { status: "confirmed", label: next }, after) } });
    expect(await storedLabels(stack, ids(members))).toEqual(labelsOf(after));

    // A budget-only default moves them with the category empty on purpose.
    const budgetOnly = { budget_id: other.budget_id, category_id: null };
    await alice.client.post("/recurrings", { recurring_id: id, label: { budget_id: other.budget_id, category_id: null } });
    const moved = [labeled(follows, budgetOnly), exception, labeled(unlabeled, budgetOnly), labeled(budgetOnlyOld, budgetOnly), budgetOnlyOther];
    expect(await storedLabels(stack, ids(members))).toEqual(labelsOf(moved));

    // An empty label clears the default and relabels nothing.
    expect((await alice.client.post<{ recurring: { label: Label } }>("/recurrings", { recurring_id: id, label: {} })).body.recurring.label).toEqual(EMPTY_LABEL);
    expect(pick(await recurringRow(id), ["label_budget_id", "label_category_id"])).toEqual({ label_budget_id: null, label_category_id: null });
    expect(await storedLabels(stack, ids(members))).toEqual(labelsOf(moved));
  });

  test("on a confirmed recurring with no default, moves the members that follow their most common confirmed label", async () => {
    const alice = await person("alice");
    const [common, rare, next] = [await label(alice), await label(alice), await label(alice)];
    const a = await tx(alice, "a", { ...pickLabel(common, 1), date: "2026-01-15" });
    const b = await tx(alice, "b", { ...pickLabel(common, 1), date: "2026-02-15" });
    const c = await tx(alice, "c", { ...pickLabel(rare, 1), date: "2026-04-15" });
    const id = await seedRecurring(stack, alice.id, { status: "confirmed", transaction_ids: ids([a, b, c]) });
    await alice.client.post("/recurrings", { recurring_id: id, label: next });
    expect(await storedLabels(stack, ids([a, b, c]))).toEqual(labelsOf([labeled(a, next), labeled(b, next), c]));
  });

  test("answers 'Recurring not found.' for a missing, deleted or stranger's recurring, and sets a group member's", async () => {
    const [alice, bob, stranger] = [await person("alice"), await person("bob"), await person("stranger")];
    await shareData(stack, alice.id, bob.id);
    const x = await label(alice);
    const deleted = await seedRecurring(stack, alice.id, { is_deleted: true });
    const theirs = await seedRecurring(stack, stranger.id);
    for (const recurring_id of [NO_SUCH_UUID, deleted, theirs]) {
      expect((await alice.client.post("/recurrings", { recurring_id, label: x })).json).toEqual(NOT_FOUND);
    }
    const m = await tx(bob, "m");
    const bobs = await seedRecurring(stack, bob.id, { transaction_ids: [m.transaction_id] });
    expect((await alice.client.post("/recurrings", { recurring_id: bobs, label: x })).json).toEqual({
      status: "success",
      body: { recurring_id: bobs, recurring: listed(bobs, { label: x }, [m]) },
    });
  });
});

describe("POST /recurrings with recurring_id and transaction_ids: add to a recurring", () => {
  test("refuses an empty list of string ids, a missing or dismissed recurring, and transactions it cannot take", async () => {
    const [alice, stranger] = [await person("alice"), await person("stranger")];
    const bill = await seedRecurring(stack, alice.id, { merchant_key: "bill" });
    const income = await seedRecurring(stack, alice.id, { merchant_key: "pay", is_income: true });
    const dismissed = await seedRecurring(stack, alice.id, { merchant_key: "d", status: "dismissed" });
    const deleted = await seedRecurring(stack, alice.id, { merchant_key: "x", is_deleted: true });
    const charge = await tx(alice, "charge");
    const deposit = await tx(alice, "deposit", { amount: -20 });
    const pending = await tx(alice, "pending", { pending: true });
    const unknownPending = await tx(alice, "unknown", { pending: null });
    const gone = await tx(alice, "gone", { is_deleted: true });
    const held = await tx(alice, "held");
    await seedRecurring(stack, alice.id, { merchant_key: "holder", status: "confirmed", transaction_ids: [held.transaction_id] });
    const theirs = await tx(stranger, "x");
    const strangers = await seedRecurring(stack, stranger.id);
    for (const [recurring_id, transaction_ids, expected] of [
      [bill, [], failed("No transactions to add.")],
      [bill, [5, null, { id: charge.transaction_id }], failed("No transactions to add.")],
      [NO_SUCH_UUID, [charge.transaction_id], failed("That recurring no longer exists.")],
      [deleted, [charge.transaction_id], failed("That recurring no longer exists.")],
      [strangers, [charge.transaction_id], failed("That recurring no longer exists.")],
      [dismissed, [charge.transaction_id], failed("That recurring was dismissed. Confirm it again before adding transactions.")],
      [bill, [charge.transaction_id, "nope"], TRANSACTIONS_GONE],
      [bill, [pending.transaction_id], TRANSACTIONS_GONE],
      [bill, [unknownPending.transaction_id], TRANSACTIONS_GONE],
      [bill, [gone.transaction_id], TRANSACTIONS_GONE],
      [bill, [theirs.transaction_id], TRANSACTIONS_GONE],
      [bill, [charge.transaction_id, deposit.transaction_id], failed("That recurring holds charges — only expenses can join it.")],
      [income, [charge.transaction_id], failed("That recurring holds income — only deposits can join it.")],
      [bill, [charge.transaction_id, held.transaction_id], IN_ANOTHER],
    ] as const) {
      const result = await alice.client.post("/recurrings", { recurring_id, transaction_ids, merchant_name: "ignored" });
      expect([recurring_id, transaction_ids, result.json]).toEqual([recurring_id, transaction_ids, expected]);
    }
    for (const id of [bill, income, dismissed]) expect((await recurringRow(id))!.transaction_ids).toEqual([]);
  });

  test("adds the transactions once each, and a suggested recurring labels none of them", async () => {
    const alice = await person("alice");
    const x = await label(alice);
    const [a, b, c] = [await tx(alice, "a", { ...pickLabel(x, 1) }), await tx(alice, "b"), await tx(alice, "c", { amount: null })];
    const elsewhere = await tx(alice, "e");
    await seedRecurring(stack, alice.id, { merchant_key: "dismissed", status: "dismissed", transaction_ids: [elsewhere.transaction_id] });
    const id = await seedRecurring(stack, alice.id, { transaction_ids: [a.transaction_id] });
    const result = await alice.client.post<RecurringAnswer>("/recurrings", {
      recurring_id: id,
      transaction_ids: [b.transaction_id, a.transaction_id, b.transaction_id, 7, c.transaction_id, elsewhere.transaction_id],
    });
    expect(result.json.status).toBe("success");
    const members = (await recurringRow(id))!.transaction_ids as string[];
    expect([...members].sort()).toEqual(ids([a, b, c, elsewhere]).sort());
    const byMember = new Map([a, b, c, elsewhere].map((t) => [t.transaction_id, t]));
    expect(result.json).toEqual({ status: "success", body: { recurring_id: id, recurring: listed(id, {}, members.map((m) => byMember.get(m)!)) } });
    expect(await storedLabels(stack, ids([b, c]))).toEqual(labelsOf([b, c]));
  });

  test("on a confirmed recurring, joining charges take its default label and, from its splits date on, its splits", async () => {
    const alice = await person("alice");
    const [x, s1, s2] = [await label(alice), await label(alice), await label(alice)];
    const first = await tx(alice, "a", { ...pickLabel(x, 1), date: "2026-01-15" });
    const joining = await tx(alice, "b", { amount: 30, date: "2026-03-15", label_category_confidence: 0.6 });
    const exception = await tx(alice, "c", { amount: 30, date: "2026-03-20", ...pickLabel(s1, 1) });
    const early = await tx(alice, "d", { amount: 30, date: "2026-02-27" });
    const small = await tx(alice, "e", { amount: 15, date: "2026-03-16" });
    const alreadySplit = await tx(alice, "f", { amount: 30, date: "2026-03-17" });
    await stack.db.insert("split_transactions", { user_id: alice.id, transaction_id: alreadySplit.transaction_id, account_id: alreadySplit.account_id, amount: "1", date: "2026-03-17" });
    const splits = [
      { amount: 10, label: { budget_id: s1.budget_id, category_id: s1.category_id } },
      { amount: 5, label: { budget_id: s2.budget_id, category_id: null } },
      { amount: 0.5, label: { budget_id: null, category_id: null } },
    ];
    const id = await seedRecurring(stack, alice.id, {
      status: "confirmed",
      transaction_ids: [first.transaction_id],
      label_budget_id: x.budget_id,
      label_category_id: x.category_id,
      splits,
      splits_since: "2026-03-01",
    });
    const joiners = [joining, exception, early, small, alreadySplit];
    const result = await alice.client.post("/recurrings", { recurring_id: id, transaction_ids: ids(joiners) });
    expect(result.json.status).toBe("success");
    expect(await storedLabels(stack, ids([first, ...joiners]))).toEqual(
      labelsOf([first, labeled(joining, x), exception, labeled(early, x), labeled(small, x), labeled(alreadySplit, x)]),
    );
    const split = (t: SeedTransaction, amount: number, l: Label, confidence: number | null) => ({
      transaction_id: t.transaction_id,
      account_id: t.account_id,
      amount,
      date: t.date,
      label_budget_id: l.budget_id,
      label_category_id: l.category_id,
      label_category_confidence: confidence,
    });
    expect(await storedSplits(stack, ids(joiners))).toEqual([
      split(joining, 0.5, EMPTY_LABEL, null),
      split(joining, 5, { budget_id: s2.budget_id, category_id: null }, 0),
      split(joining, 10, s1, 1),
      split(exception, 0.5, EMPTY_LABEL, null),
      split(exception, 5, { budget_id: s2.budget_id, category_id: null }, 0),
      split(exception, 10, s1, 1),
      split(alreadySplit, 1, EMPTY_LABEL, null),
    ]);
  });

  test("splits a refund with its sign, and leaves joining charges' labels alone when there is no default", async () => {
    const alice = await person("alice");
    const s = await label(alice);
    const first = await tx(alice, "a", { amount: -40, date: "2026-03-01" });
    const joining = await tx(alice, "b", { amount: -40, date: "2026-03-15", ...pickLabel(s, 0.5) });
    const id = await seedRecurring(stack, alice.id, {
      is_income: true,
      status: "confirmed",
      transaction_ids: [first.transaction_id],
      splits: [{ amount: 15, label: { budget_id: s.budget_id, category_id: s.category_id } }],
      splits_since: "2026-03-15",
    });
    expect((await alice.client.post("/recurrings", { recurring_id: id, transaction_ids: [joining.transaction_id] })).json.status).toBe("success");
    expect(await storedLabels(stack, ids([joining]))).toEqual(labelsOf([joining]));
    expect(await storedSplits(stack, ids([joining]))).toEqual([
      { transaction_id: joining.transaction_id, account_id: joining.account_id, amount: -15, date: joining.date, label_budget_id: s.budget_id, label_category_id: s.category_id, label_category_confidence: 1 },
    ]);
  });

  test("adds to a group member's recurring their own transactions only", async () => {
    const [alice, bob] = [await person("alice"), await person("bob")];
    await shareData(stack, alice.id, bob.id);
    const [b1, b2, a1] = [await tx(bob, "b1"), await tx(bob, "b2"), await tx(alice, "a1")];
    const id = await seedRecurring(stack, bob.id, { transaction_ids: [b1.transaction_id] });
    expect((await alice.client.post("/recurrings", { recurring_id: id, transaction_ids: [a1.transaction_id] })).json).toEqual(TRANSACTIONS_GONE);
    expect((await alice.client.post("/recurrings", { recurring_id: id, transaction_ids: [b2.transaction_id] })).json.status).toBe("success");
    expect([...((await recurringRow(id))!.transaction_ids as string[])].sort()).toEqual(ids([b1, b2]).sort());
  });
});

describe("POST /recurrings with transaction_ids alone: create", () => {
  test("refuses transaction_ids that is not an array holding a string", async () => {
    const alice = await person("alice");
    for (const [body, message] of [
      [{}, "transaction_ids must be an array of transaction ids"],
      [{ transaction_ids: null }, "transaction_ids must be an array of transaction ids"],
      [{ transaction_ids: "a" }, "transaction_ids must be an array of transaction ids"],
      [{ transaction_ids: { 0: "a" } }, "transaction_ids must be an array of transaction ids"],
      [{ recurring_id: 5, merchant_name: "x" }, "transaction_ids must be an array of transaction ids"],
      [{ transaction_ids: [] }, "at least one transaction is required"],
      [{ transaction_ids: [5, null, ["a"]] }, "at least one transaction is required"],
    ] as const) {
      expect([body, (await alice.client.post("/recurrings", body)).json]).toEqual([body, failed(message)]);
    }
    expect(await recurringsOf(alice.id)).toEqual([]);
  });

  test("refuses transactions that are missing, deleted, pending, zero, a stranger's, or named twice", async () => {
    const [alice, stranger] = [await person("alice"), await person("stranger")];
    const a = await tx(alice, "a");
    const gone = await tx(alice, "gone", { is_deleted: true });
    const pending = await tx(alice, "pending", { pending: true });
    const zero = await tx(alice, "zero", { amount: 0 });
    const theirs = await tx(stranger, "x");
    for (const transaction_ids of [
      [a.transaction_id, "nope"],
      [gone.transaction_id],
      [a.transaction_id, pending.transaction_id],
      [zero.transaction_id],
      [a.transaction_id, theirs.transaction_id],
      [a.transaction_id, a.transaction_id],
    ]) {
      expect([transaction_ids, (await alice.client.post("/recurrings", { transaction_ids })).json]).toEqual([transaction_ids, TRANSACTIONS_GONE]);
    }
    expect(await recurringsOf(alice.id)).toEqual([]);
  });

  test("refuses transactions of different merchants or directions, or with no name to key on", async () => {
    const alice = await person("alice");
    const a = await tx(alice, "a", { merchant_name: "NETFLIX.COM" });
    const hulu = await tx(alice, "hulu", { merchant_name: "Hulu" });
    const refund = await tx(alice, "refund", { amount: -15.99 });
    const blank = await tx(alice, "blank", { merchant_name: null, name: "!!!" });
    const nameless = await tx(alice, "nameless", { merchant_name: "", name: null });
    for (const group of [[a, hulu], [a, refund], [blank], [nameless], [blank, nameless]]) {
      expect((await alice.client.post("/recurrings", { transaction_ids: ids(group) })).json).toEqual(NOT_ONE_GROUP);
    }
    expect(await recurringsOf(alice.id)).toEqual([]);
  });

  test("creates a confirmed recurring from one transaction, monthly by default, and answers with it", async () => {
    const alice = await person("alice");
    const a = await tx(alice, "a", { merchant_name: null, name: "Gym Club 8665795717" });
    const result = await alice.client.post<RecurringAnswer>("/recurrings", { transaction_ids: [a.transaction_id, 9] });
    const id = result.body.recurring_id;
    expect(id).toMatch(UUID);
    const fields = { merchant_key: "gym club", merchant_name: "Gym Club 8665795717", status: "confirmed" };
    expect(result.json).toEqual({ status: "success", body: { recurring_id: id, recurring: listed(id, fields, [a]) } });
    expect(await recurringRow(id)).toEqual({
      user_id: alice.id,
      ...fields,
      cadence: "monthly",
      is_income: false,
      transaction_ids: [a.transaction_id],
      label_budget_id: null,
      label_category_id: null,
      splits: [],
      splits_since: null,
      is_deleted: false,
    });
  });

  test("estimates the cadence from the median interval, whatever order the ids come in", async () => {
    const alice = await person("alice");
    const cases: [number[], string][] = [
      [[0], "weekly"],
      [[10], "weekly"],
      [[11], "biweekly"],
      [[21], "biweekly"],
      [[22], "monthly"],
      [[45], "monthly"],
      [[46], "quarterly"],
      [[120], "quarterly"],
      [[121], "semiannual"],
      [[270], "semiannual"],
      [[271], "annual"],
      [[800], "annual"],
      [[90, 7, 30], "monthly"],
      [[7, 40], "monthly"],
      [[50, 7], "quarterly"],
    ];
    for (const [i, [intervals, cadence]] of cases.entries()) {
      const merchant = `Merchant ${String.fromCharCode(65 + i)}`;
      const dates = ["2024-01-01"];
      for (const days of intervals) {
        const next = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + days);
        dates.push(next.toISOString().slice(0, 10));
      }
      const members = [];
      for (const [j, date] of dates.entries()) members.push(await tx(alice, `${i}-${j}`, { merchant_name: merchant, date }));
      const result = await alice.client.post<RecurringAnswer>("/recurrings", { transaction_ids: ids(members).reverse() });
      expect([intervals, (await recurringRow(result.body.recurring_id))!.cadence]).toEqual([intervals, cadence]);
    }
  });

  test("names it as asked, trimmed, or by the most common name among the members", async () => {
    const alice = await person("alice");
    const a = await tx(alice, "a", { merchant_name: "NETFLIX.COM" });
    const b = await tx(alice, "b", { merchant_name: "Netflix" });
    const c = await tx(alice, "c", { merchant_name: null, name: "Netflix" });
    const custom = await alice.client.post<RecurringAnswer>("/recurrings", { transaction_ids: ids([a]), merchant_name: "  Movies\t" });
    expect(pick(await recurringRow(custom.body.recurring_id), ["merchant_key", "merchant_name"])).toEqual({ merchant_key: "netflix", merchant_name: "Movies" });
    // Landing on the same merchant again merges into that recurring; a blank name is not a name.
    const merged = await alice.client.post<RecurringAnswer>("/recurrings", { transaction_ids: ids([b, c]), merchant_name: "  " });
    expect(merged.body.recurring_id).toBe(custom.body.recurring_id);
    expect(pick(await recurringRow(custom.body.recurring_id), ["merchant_name"])).toEqual({ merchant_name: "Movies" });
    // A name given with the next transaction replaces it; one it already holds would collide.
    expect((await alice.client.post("/recurrings", { transaction_ids: ids([a]), merchant_name: "Again" })).json).toEqual(IN_ANOTHER);
    const d = await tx(alice, "d", { merchant_name: "netflix" });
    const renamed = await alice.client.post<RecurringAnswer>("/recurrings", { transaction_ids: ids([d]), merchant_name: "Renamed" });
    expect(renamed.body.recurring_id).toBe(custom.body.recurring_id);
    expect(pick(await recurringRow(custom.body.recurring_id), ["merchant_name"])).toEqual({ merchant_name: "Renamed" });
    expect([...((await recurringRow(custom.body.recurring_id))!.transaction_ids as string[])].sort()).toEqual(ids([a, b, c, d]));

    const bob = await person("bob");
    const tie = [await tx(bob, "x", { merchant_name: "Hulu LLC" }), await tx(bob, "y", { merchant_name: "HULU LLC" })];
    const most = [await tx(bob, "p", { amount: -100, merchant_name: "ACME PAY" }), await tx(bob, "q", { amount: -100, merchant_name: "Acme Pay" }), await tx(bob, "r", { amount: -100, merchant_name: "Acme Pay" })];
    const tied = await bob.client.post<RecurringAnswer>("/recurrings", { transaction_ids: ids(tie).reverse() });
    expect(pick(await recurringRow(tied.body.recurring_id), ["merchant_key", "merchant_name"])).toEqual({ merchant_key: "hulu llc", merchant_name: "Hulu LLC" });
    const income = await bob.client.post<RecurringAnswer>("/recurrings", { transaction_ids: ids(most) });
    expect(pick(await recurringRow(income.body.recurring_id), ["merchant_key", "merchant_name", "is_income"])).toEqual({ merchant_key: "acme pay", merchant_name: "Acme Pay", is_income: true });
  });

  test("lands on a dismissed, suggested or deleted recurring of the merchant, confirming it", async () => {
    const alice = await person("alice");
    const [a, b, c, d, e] = await Promise.all(["a", "b", "c", "d", "e"].map((s, i) => tx(alice, s, { merchant_name: ["Alpha", "Alpha", "Beta", "Gamma", "Gamma"][i] })));
    const dismissed = await seedRecurring(stack, alice.id, { merchant_key: "alpha", merchant_name: "Old Alpha", cadence: "weekly", status: "dismissed", transaction_ids: [a.transaction_id] });
    const suggested = await seedRecurring(stack, alice.id, { merchant_key: "beta", merchant_name: "Beta", status: "suggested" });
    const deleted = await seedRecurring(stack, alice.id, { merchant_key: "gamma", merchant_name: "Gamma", status: "confirmed", is_deleted: true, transaction_ids: ["old-gone"] });
    for (const [group, id, name] of [
      [[a, b], dismissed, "Old Alpha"],
      [[c], suggested, "Beta"],
      [[d, e], deleted, "Gamma"],
    ] as const) {
      const result = await alice.client.post<RecurringAnswer>("/recurrings", { transaction_ids: ids([...group]) });
      expect(result.body.recurring_id).toBe(id);
      const row = (await recurringRow(id))!;
      expect(pick(row, ["merchant_name", "status", "is_deleted"])).toEqual({ merchant_name: name, status: "confirmed", is_deleted: false });
    }
    expect((await recurringRow(dismissed))!.cadence).toBe("weekly");
    expect([...((await recurringRow(deleted))!.transaction_ids as string[])].sort()).toEqual(["old-gone", ...ids([d, e])].sort());
  });

  test("refuses a transaction already in another active recurring", async () => {
    const alice = await person("alice");
    const [a, b] = [await tx(alice, "a"), await tx(alice, "b", { merchant_name: "Other" })];
    await seedRecurring(stack, alice.id, { merchant_key: "other", status: "suggested", transaction_ids: [a.transaction_id] });
    expect((await alice.client.post("/recurrings", { transaction_ids: [a.transaction_id] })).json).toEqual(IN_ANOTHER);
    // A dismissed recurring holds nothing.
    await seedRecurring(stack, alice.id, { merchant_key: "kept", status: "dismissed", transaction_ids: [b.transaction_id] });
    expect((await alice.client.post("/recurrings", { transaction_ids: [b.transaction_id] })).json.status).toBe("success");
  });

  test("starts its default label from the members' confirmed labels and relabels the rest", async () => {
    const alice = await person("alice");
    const x = await label(alice);
    const a = await tx(alice, "a", { ...pickLabel(x, 1) });
    const b = await tx(alice, "b");
    const result = await alice.client.post<RecurringAnswer>("/recurrings", { transaction_ids: ids([a, b]) });
    const id = result.body.recurring_id;
    expect(result.json).toEqual({
      status: "success",
      // Two charges on one day are a zero-day interval: weekly.
      body: { recurring_id: id, recurring: listed(id, { merchant_key: "netflix", merchant_name: "Netflix", cadence: "weekly", status: "confirmed", label: x }, [a, labeled(b, x)]) },
    });
  });

  test("creates from a group member's transactions under that member, and refuses a mix of two people's", async () => {
    const [alice, bob] = [await person("alice"), await person("bob")];
    await shareData(stack, alice.id, bob.id);
    const [b1, b2, a1] = [await tx(bob, "b1"), await tx(bob, "b2"), await tx(alice, "a1")];
    expect((await alice.client.post("/recurrings", { transaction_ids: [b1.transaction_id, a1.transaction_id] })).json).toEqual(TRANSACTIONS_GONE);
    // The owner is looked up from the first id only when it is a string; otherwise the caller is.
    expect((await alice.client.post("/recurrings", { transaction_ids: [5, b1.transaction_id, b2.transaction_id] })).json).toEqual(TRANSACTIONS_GONE);
    const result = await alice.client.post<RecurringAnswer>("/recurrings", { transaction_ids: ids([b1, b2]) });
    expect(result.json.status).toBe("success");
    expect(pick(await recurringRow(result.body.recurring_id), ["user_id", "status"])).toEqual({ user_id: bob.id, status: "confirmed" });
    expect(await recurringsOf(alice.id)).toEqual([]);
  });
});

describe("DELETE /recurrings", () => {
  test("refuses a missing, repeated or empty id", async () => {
    const alice = await person("alice");
    for (const [query, message] of [
      ["", "Missing required parameter: id"],
      ["?ID=x", "Missing required parameter: id"],
      [`?id=${NO_SUCH_UUID}&id=${NO_SUCH_UUID}`, "Parameter id must be a single value, not an array"],
      ["?id=", "Parameter id cannot be empty"],
      ["?id=%20%C2%A0", "Parameter id cannot be empty"],
    ]) {
      expect([query, (await alice.client.delete(`/recurrings${query}`)).json]).toEqual([query, failed(message)]);
    }
  });

  test("fails as a server error, and alarms, on an id that is not a UUID", async () => {
    const alice = await person("alice");
    const route = "DELETE /recurrings";
    expect(alarmsFor(route)).toHaveLength(0);
    const result = await alice.client.delete("/recurrings", { query: { id: "nope" } });
    expect([result.status, result.json]).toEqual([500, SERVER_ERROR]);
    await stack.waitFor(() => alarmsFor(route).length > 0, { what: `the ${route} alarm` });
    expect(alarmsFor(route)[0].description).toBe('**Error:** invalid input syntax for type uuid: "nope"');
  });

  test("dismisses the caller's recurring, suggested, confirmed or already dismissed, and a group member's as its owner", async () => {
    const [alice, bob] = [await person("alice"), await person("bob")];
    await shareData(stack, alice.id, bob.id);
    const ids = [
      await seedRecurring(stack, alice.id, { merchant_key: "s" }),
      await seedRecurring(stack, alice.id, { merchant_key: "c", status: "confirmed" }),
      await seedRecurring(stack, alice.id, { merchant_key: "d", status: "dismissed" }),
      await seedRecurring(stack, bob.id, { merchant_key: "b", status: "confirmed" }),
    ];
    for (const id of ids) {
      const result = await alice.client.delete("/recurrings", { query: { id } });
      expect([id, result.status, result.json]).toEqual([id, 200, SUCCESS]);
      expect((await recurringRow(id))!.status).toBe("dismissed");
    }
    expect((await alice.client.get("/recurrings")).body).toEqual([]);
  });

  test("answers 'Recurring not found.' for a missing, deleted or stranger's recurring", async () => {
    const [alice, stranger] = [await person("alice"), await person("stranger")];
    const deleted = await seedRecurring(stack, alice.id, { is_deleted: true });
    const theirs = await seedRecurring(stack, stranger.id);
    for (const id of [NO_SUCH_UUID, deleted, theirs]) {
      expect((await alice.client.delete("/recurrings", { query: { id } })).json).toEqual(NOT_FOUND);
    }
    expect((await recurringRow(deleted))!.status).toBe("suggested");
    expect((await recurringRow(theirs))!.status).toBe("suggested");
  });
});
