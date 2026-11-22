import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUserClient, startStack, type ApiClient, type Stack } from "../harness";
import { NO_SUCH_ID } from "../harness/query-cases";
import { seedApiKey, softDelete, storedRows } from "../harness/seed/budgets";
import {
  seedCategoryTree,
  seedTransaction,
  shareData,
  storedTransaction,
  withUpdatesDropped,
} from "../harness/seed/transactions";

let stack: Stack;
/** Shares data with `partner`; never with `stranger`. */
let owner: ApiClient;
let ownerId: string;
let partnerId: string;
let strangerId: string;
let own: { budget_id: string; section_id: string; category_id: string };
let partners: { budget_id: string; section_id: string; category_id: string };
let strangers: { budget_id: string; section_id: string; category_id: string };
beforeAll(async () => {
  stack = await startStack();
  ({ client: owner, user: { user_id: ownerId } } = await createUserClient(stack, "suggest-owner"));
  ({ user: { user_id: partnerId } } = await createUserClient(stack, "suggest-partner"));
  ({ user: { user_id: strangerId } } = await createUserClient(stack, "suggest-stranger"));
  await shareData(stack, ownerId, partnerId);
  own = await seedCategoryTree(stack, ownerId);
  partners = await seedCategoryTree(stack, partnerId);
  strangers = await seedCategoryTree(stack, strangerId);
});
afterAll(() => stack.stop());

const SERVER_ERROR = { status: "error", message: "Internal server error" };
const failed = (message: string) => ({ status: "failed", message });
const BODY_SHAPE = "Body must be { suggestions: [{ transaction_id, confidence, ... }] }";
const INVALID_SHAPE =
  "Invalid shape. Required: { transaction_id: string, confidence: number in (0,1) exclusive }, with optional label_category_id and label_budget_id.";
const NOT_FOUND = "Transaction not found or not owned by this user.";
const CONFIRMED = "Refusing to overwrite user-confirmed label (confidence = 1.0).";
const NO_LABEL = "At least one of label_category_id / label_budget_id is required.";

type Outcome = { transaction_id: string; status: string; reason?: string };
interface Answer {
  outcomes: Outcome[];
  updated: number;
  skipped: number;
  errored: number;
}

const updated = (transaction_id: string): Outcome => ({ transaction_id, status: "updated" });
const skipped = (transaction_id: string, reason: string): Outcome => ({ transaction_id, status: "skipped", reason });
const errored = (transaction_id: string, reason: string): Outcome => ({ transaction_id, status: "error", reason });
const answer = (...outcomes: Outcome[]) => ({
  status: "success",
  body: {
    outcomes,
    updated: outcomes.filter((o) => o.status === "updated").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    errored: outcomes.filter((o) => o.status === "error").length,
  },
});

const alarmsFor = (route: string) =>
  stack.upstream.discord.alarms().filter((alarm) => alarm.title === `🚨 Budget Server Error: Route Error: ${route}`);

const suggest = (body: unknown, client: ApiClient = owner) => client.post<Answer>("/suggest-category", body);

/** An unlabeled transaction of the owner, unless `row` says otherwise. */
const target = (row: Record<string, unknown> = {}) => seedTransaction(stack, ownerId, { account_id: "acc-suggest", ...row });

const labelOf = async (transaction_id: string) => {
  const row = await storedTransaction(stack, transaction_id);
  return [row.label_category_id, row.label_budget_id, row.label_category_confidence];
};

describe("who may suggest", () => {
  test("a caller without a session or key is refused", async () => {
    const transaction_id = await target();
    const result = await stack.anonymous().post("/suggest-category", { suggestions: [{ transaction_id, confidence: 0.5, label_category_id: own.category_id }] });
    expect([result.status, result.json]).toEqual([401, failed("Not authenticated.")]);
    expect(await labelOf(transaction_id)).toEqual([null, null, null]);
  });

  test("an API key holding the transactions:suggest scope may, for the rows of its user's sharing group", async () => {
    const key = await seedApiKey(stack, ownerId, ["transactions:suggest"]);
    const own_tx = await target();
    const partners_tx = await seedTransaction(stack, partnerId, { account_id: "acc-partner" });
    const strangers_tx = await seedTransaction(stack, strangerId);
    const keyed = stack.anonymous();
    const result = await keyed.post<Answer>(
      "/suggest-category",
      {
        suggestions: [
          { transaction_id: own_tx, confidence: 0.6, label_category_id: own.category_id, label_budget_id: own.budget_id },
          { transaction_id: partners_tx, confidence: 0.7, label_category_id: partners.category_id },
          { transaction_id: strangers_tx, confidence: 0.8, label_category_id: own.category_id },
        ],
      },
      { headers: { Authorization: `Bearer ${key}`, "X-Real-IP": "10.54.0.1" } },
    );
    expect(result.status).toBe(200);
    expect(result.json).toEqual(answer(updated(own_tx), updated(partners_tx), skipped(strangers_tx, NOT_FOUND)));
    expect(result.setCookies).toEqual([]);
    expect(await labelOf(own_tx)).toEqual([own.category_id, own.budget_id, 0.6]);
    expect(await labelOf(partners_tx)).toEqual([partners.category_id, null, 0.7]);
    expect((await storedTransaction(stack, partners_tx)).user_id).toBe(partnerId);
    expect(await labelOf(strangers_tx)).toEqual([null, null, null]);
    await stack.waitFor(async () => (await stack.db.rows("api_keys", { user_id: ownerId }))[0]?.last_used_at, { what: "the key's use" });
  });

  test("a key without the scope, a revoked or expired key, or a token that is no key is refused", async () => {
    const transaction_id = await target();
    const keys = [
      await seedApiKey(stack, strangerId, ["budgets:read"]),
      await seedApiKey(stack, strangerId, []),
      `${await seedApiKey(stack, strangerId, ["transactions:suggest"])}x`,
      "bk_not-a-key",
      "not-even-prefixed",
    ];
    const revoked = await seedApiKey(stack, strangerId, ["transactions:suggest"]);
    await stack.db.query("UPDATE api_keys SET revoked_at = NOW() WHERE key_prefix = $1", [revoked.slice(0, 11)]);
    const expired = await seedApiKey(stack, strangerId, ["transactions:suggest"]);
    await stack.db.query("UPDATE api_keys SET expires_at = NOW() - INTERVAL '1 minute' WHERE key_prefix = $1", [expired.slice(0, 11)]);
    keys.push(revoked, expired);
    for (const [index, key] of keys.entries()) {
      for (const authorization of [`Bearer ${key}`, key]) {
        const result = await stack.anonymous().post(
          "/suggest-category",
          { suggestions: [{ transaction_id, confidence: 0.5, label_category_id: own.category_id }] },
          { headers: { Authorization: authorization, "X-Real-IP": `10.54.1.${index + 1}` } },
        );
        expect([index, authorization === key, result.status, result.json]).toEqual([index, authorization === key, 401, failed("Not authenticated.")]);
      }
    }
    expect(await labelOf(transaction_id)).toEqual([null, null, null]);
  });

  test("a signed-in session may, and its cookie wins over a key sent alongside it", async () => {
    const key = await seedApiKey(stack, strangerId, ["transactions:suggest"]);
    const transaction_id = await target();
    const result = await owner.post<Answer>(
      "/suggest-category",
      { suggestions: [{ transaction_id, confidence: 0.25, label_budget_id: own.budget_id }] },
      { headers: { Authorization: `Bearer ${key}`, "X-Real-IP": "10.54.2.1" } },
    );
    expect(result.json).toEqual(answer(updated(transaction_id)));
    expect(await labelOf(transaction_id)).toEqual([null, own.budget_id, 0.25]);
  });
});

describe("the body", () => {
  test("must carry a suggestions array", async () => {
    for (const body of [
      undefined,
      null,
      [],
      [{ transaction_id: "t", confidence: 0.5 }],
      "suggestions",
      5,
      0,
      true,
      false,
      {},
      { suggestions: null },
      { suggestions: {} },
      { suggestions: { 0: { transaction_id: "t", confidence: 0.5 } } },
      { suggestions: "[]" },
      { suggestions: 3 },
      { Suggestions: [] },
    ]) {
      const result = await suggest(body);
      expect([body, result.status, result.json]).toEqual([body, 200, failed(BODY_SHAPE)]);
    }
  });

  test("answers an empty batch with nothing done", async () => {
    expect((await suggest({ suggestions: [], other: 1 })).json).toEqual(answer());
  });

  test("holds at most 500 suggestions", async () => {
    const entry = (i: number) => ({ transaction_id: `missing-${i}`, confidence: 0.5, label_budget_id: null });
    const atCap = await suggest({ suggestions: Array.from({ length: 500 }, (_, i) => entry(i)) });
    expect(atCap.json).toEqual(answer(...Array.from({ length: 500 }, (_, i) => skipped(`missing-${i}`, NOT_FOUND))));
    const overCap = await suggest({ suggestions: Array.from({ length: 501 }, (_, i) => entry(i)) });
    expect(overCap.json).toEqual(failed("suggestions array must contain at most 500 entries per request"));
    const invalidOverCap = await suggest({ suggestions: Array.from({ length: 501 }, () => null) });
    expect(invalidOverCap.json).toEqual(failed("suggestions array must contain at most 500 entries per request"));
  });
});

describe("each suggestion", () => {
  test("of the wrong shape is reported first, named by its id as text, and writes nothing", async () => {
    const transaction_id = await target();
    const valid = { transaction_id, confidence: 0.5, label_category_id: own.category_id };
    const invalid: [unknown, string][] = [
      [null, "<invalid>"],
      [7, "<invalid>"],
      ["tx", "<invalid>"],
      [[transaction_id], "<invalid>"],
      [{}, "<invalid>"],
      [{ transaction_id: null, confidence: 0.5 }, "<invalid>"],
      [{ transaction_id: 42, confidence: 0.5 }, "42"],
      [{ transaction_id: 1.5e21, confidence: 0.5 }, "1.5e+21"],
      [{ transaction_id: false, confidence: 0.5 }, "false"],
      [{ transaction_id: { id: "x" }, confidence: 0.5 }, "[object Object]"],
      [{ transaction_id: [1, null, [2, "three"], { a: 1 }, true], confidence: 0.5 }, "1,,2,three,[object Object],true"],
      [{ transaction_id: [], confidence: 0.5 }, ""],
      [{ transaction_id: { toString: null }, confidence: 0.5 }, "<invalid>"],
      [{ transaction_id }, transaction_id],
      [{ transaction_id, confidence: null }, transaction_id],
      [{ transaction_id, confidence: "0.5" }, transaction_id],
      [{ transaction_id, confidence: 0 }, transaction_id],
      [{ transaction_id, confidence: 1 }, transaction_id],
      [{ transaction_id, confidence: -0.5 }, transaction_id],
      [{ transaction_id, confidence: 1.01 }, transaction_id],
      [{ transaction_id, confidence: 0.5, label_category_id: 5 }, transaction_id],
      [{ transaction_id, confidence: 0.5, label_category_id: [] }, transaction_id],
      [{ transaction_id, confidence: 0.5, label_budget_id: {} }, transaction_id],
      [{ transaction_id, confidence: 0.5, label_budget_id: true }, transaction_id],
    ];
    const result = await suggest({ suggestions: [valid, ...invalid.map(([raw]) => raw)] });
    expect(result.json).toEqual(answer(...invalid.map(([, id]) => errored(id, INVALID_SHAPE)), updated(transaction_id)));
    expect(await labelOf(transaction_id)).toEqual([own.category_id, null, 0.5]);

    // A batch of nothing valid looks nothing up.
    const none = await suggest({ suggestions: invalid.map(([raw]) => raw) });
    expect(none.json).toEqual(answer(...invalid.map(([, id]) => errored(id, INVALID_SHAPE))));
  });

  test("is skipped for a transaction that is missing, deleted or another user's, and for one the user confirmed", async () => {
    const deleted = await target({ is_deleted: true });
    const strangers_tx = await seedTransaction(stack, strangerId);
    const confirmed = await target({ label_category_id: own.category_id, label_category_confidence: 1 });
    const before = await storedRows(stack, "transactions");
    const result = await suggest({
      suggestions: [
        { transaction_id: "no-such-transaction", confidence: 0.5, label_category_id: own.category_id },
        { transaction_id: deleted, confidence: 0.5, label_category_id: own.category_id },
        { transaction_id: strangers_tx, confidence: 0.5, label_category_id: strangers.category_id },
        { transaction_id: confirmed, confidence: 0.5, label_category_id: partners.category_id },
        // The confirmation is checked before the labels.
        { transaction_id: confirmed, confidence: 0.5, label_category_id: NO_SUCH_ID },
        { transaction_id: confirmed, confidence: 0.5 },
      ],
    });
    expect(result.json).toEqual(
      answer(
        skipped("no-such-transaction", NOT_FOUND),
        skipped(deleted, NOT_FOUND),
        skipped(strangers_tx, NOT_FOUND),
        skipped(confirmed, CONFIRMED),
        skipped(confirmed, CONFIRMED),
        skipped(confirmed, CONFIRMED),
      ),
    );
    expect(await storedRows(stack, "transactions")).toEqual(before);
  });

  test("errs for a category or budget outside the sharing group, deleted, missing or malformed, the category first", async () => {
    const deleted = await seedCategoryTree(stack, ownerId);
    await softDelete(stack, "categories", deleted.category_id);
    await softDelete(stack, "budgets", deleted.budget_id);
    const transaction_id = await target();
    const unknownCategories = [strangers.category_id, deleted.category_id, NO_SUCH_ID, "not-a-uuid", NO_SUCH_ID.toUpperCase().replace(/-/g, "")];
    const unknownBudgets = [strangers.budget_id, deleted.budget_id, NO_SUCH_ID, "bad"];
    const result = await suggest({
      suggestions: [
        ...unknownCategories.map((id) => ({ transaction_id, confidence: 0.5, label_category_id: id })),
        ...unknownBudgets.map((id) => ({ transaction_id, confidence: 0.5, label_budget_id: id })),
        { transaction_id, confidence: 0.5, label_category_id: "bad-category", label_budget_id: "bad-budget" },
        { transaction_id, confidence: 0.5, label_category_id: own.category_id, label_budget_id: strangers.budget_id },
        { transaction_id, confidence: 0.5 },
        { transaction_id, confidence: 0.5, other: "label" },
      ],
    });
    expect(result.json).toEqual(
      answer(
        ...unknownCategories.map((id) => errored(transaction_id, `Unknown label_category_id: ${id}`)),
        ...unknownBudgets.map((id) => errored(transaction_id, `Unknown label_budget_id: ${id}`)),
        errored(transaction_id, "Unknown label_category_id: bad-category"),
        errored(transaction_id, `Unknown label_budget_id: ${strangers.budget_id}`),
        errored(transaction_id, NO_LABEL),
        errored(transaction_id, NO_LABEL),
      ),
    );
    expect(await labelOf(transaction_id)).toEqual([null, null, null]);
  });

  test("writes the labels it names and the confidence, over a suggestion, a cleared label or none, leaving the rest", async () => {
    const cases: [Record<string, unknown>, Record<string, unknown>, unknown[]][] = [
      [{}, { label_category_id: "OWN" }, ["OWN", null, 0.5]],
      [{}, { label_budget_id: "OWN_BUDGET" }, [null, "OWN_BUDGET", 0.5]],
      [{}, { label_category_id: "OWN", label_budget_id: "OWN_BUDGET" }, ["OWN", "OWN_BUDGET", 0.5]],
      [{}, { label_category_id: "PARTNER", label_budget_id: "PARTNER_BUDGET" }, ["PARTNER", "PARTNER_BUDGET", 0.5]],
      [
        { label_category_id: "PARTNER", label_budget_id: "PARTNER_BUDGET", label_category_confidence: 0.7 },
        { label_category_id: "OWN" },
        ["OWN", "PARTNER_BUDGET", 0.5],
      ],
      [
        { label_category_id: "PARTNER", label_budget_id: "PARTNER_BUDGET", label_category_confidence: 0 },
        { label_budget_id: "OWN_BUDGET" },
        ["PARTNER", "OWN_BUDGET", 0.5],
      ],
      [{ label_category_id: "OWN", label_budget_id: "OWN_BUDGET", label_category_confidence: 0.9 }, { label_category_id: null, label_budget_id: null }, [null, null, 0.5]],
      [{ label_category_id: "OWN", label_category_confidence: 0.9 }, { label_category_id: null }, [null, null, 0.5]],
    ];
    const resolve = (value: unknown) =>
      ({ OWN: own.category_id, OWN_BUDGET: own.budget_id, PARTNER: partners.category_id, PARTNER_BUDGET: partners.budget_id })[
        value as string
      ] ?? value;
    const resolveAll = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, resolve(value)]));
    for (const [row, labels, expected] of cases) {
      const transaction_id = await target({ ...resolveAll(row), label_memo: "kept", name: "Kept" });
      const result = await suggest({ suggestions: [{ transaction_id, confidence: 0.5, ...resolveAll(labels) }] });
      expect([row, labels, result.json]).toEqual([row, labels, answer(updated(transaction_id))]);
      expect([row, labels, await labelOf(transaction_id)]).toEqual([row, labels, expected.map(resolve)]);
      const stored = await storedTransaction(stack, transaction_id);
      expect([stored.label_memo, stored.name]).toEqual(["kept", "Kept"]);
    }
    for (const confidence of [0.000001, 0.999999, 0.98]) {
      const transaction_id = await target();
      expect((await suggest({ suggestions: [{ transaction_id, confidence, label_budget_id: own.budget_id }] })).json).toEqual(answer(updated(transaction_id)));
      expect((await labelOf(transaction_id))[2]).toBe(confidence);
    }
  });

  test("keeps the input order across many concurrent writes, and writes a repeated suggestion each time", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) ids.push(await target());
    const suggestions: Record<string, unknown>[] = [];
    const expected: Outcome[] = [];
    for (const [i, transaction_id] of ids.entries()) {
      suggestions.push({ transaction_id, confidence: 0.5 + i / 100, label_category_id: own.category_id });
      expected.push(updated(transaction_id));
      if (i % 4 === 0) {
        suggestions.push({ transaction_id: `missing-${i}`, confidence: 0.5, label_category_id: own.category_id });
        expected.push(skipped(`missing-${i}`, NOT_FOUND));
      }
    }
    suggestions.push({ transaction_id: ids[0], confidence: 0.5, label_category_id: own.category_id });
    expected.push(updated(ids[0]));
    suggestions.unshift({ transaction_id: ids[0], confidence: 0.5, label_category_id: own.category_id });
    expected.unshift(updated(ids[0]));
    const result = await suggest({ suggestions });
    expect(result.json).toEqual(answer(...expected));
    for (const [i, transaction_id] of ids.entries()) {
      expect(await labelOf(transaction_id)).toEqual([own.category_id, null, i === 0 ? 0.5 : 0.5 + i / 100]);
    }
  });

  test("errs for a write the database refuses, and is skipped for one that changes no row, without failing the rest", async () => {
    const good = await target();
    const emptyCategory = await target();
    const emptyBudget = await target();
    const result = await suggest({
      suggestions: [
        { transaction_id: emptyCategory, confidence: 0.5, label_category_id: "" },
        { transaction_id: good, confidence: 0.5, label_category_id: own.category_id },
        { transaction_id: emptyBudget, confidence: 0.5, label_budget_id: "" },
      ],
    });
    expect(result.json).toEqual(
      answer(errored(emptyCategory, "Internal error during update."), updated(good), errored(emptyBudget, "Internal error during update.")),
    );
    await stack.waitForLog(`suggest-category update failed {"transactionId":"${emptyCategory}"}`);
    await stack.waitForLog(`suggest-category update failed {"transactionId":"${emptyBudget}"}`);
    expect(await labelOf(good)).toEqual([own.category_id, null, 0.5]);
    expect(await labelOf(emptyCategory)).toEqual([null, null, null]);

    const dropped = await target();
    await withUpdatesDropped(stack, "transactions", async () => {
      const answerDropped = await suggest({ suggestions: [{ transaction_id: dropped, confidence: 0.5, label_category_id: own.category_id }] });
      expect(answerDropped.json).toEqual(answer(skipped(dropped, "Update produced no row change (concurrent modification?).")));
    });
    expect(await labelOf(dropped)).toEqual([null, null, null]);
    // No alarm: these are per-row outcomes, not route failures.
    expect(alarmsFor("POST /suggest-category")).toHaveLength(0);
  });

  test("an id whose toString is not a function fails the whole request, as calling it does", async () => {
    const route = "POST /suggest-category";
    const transaction_id = await target();
    const result = await suggest({
      suggestions: [
        { transaction_id, confidence: 0.5, label_category_id: own.category_id },
        { transaction_id: { toString: 5 }, confidence: 0.5 },
      ],
    });
    expect([result.status, result.json]).toEqual([500, SERVER_ERROR]);
    await stack.waitFor(() => alarmsFor(route).length > 0, { what: `the ${route} alarm` });
    expect(alarmsFor(route).map((alarm) => alarm.description)).toEqual([
      "**Error:** raw?.transaction_id?.toString is not a function. (In 'raw?.transaction_id?.toString?.()', 'raw?.transaction_id?.toString' is 5)",
    ]);
    for (const raw of [
      { transaction_id: { toString: "x" } },
      { transaction_id: { toString: {} } },
      { transaction_id: { toString: [1] } },
      { transaction_id: { toString: false } },
      { transaction_id: [{ toString: 1 }] },
      { transaction_id: [[{ toString: null }]] },
    ]) {
      const again = await suggest({ suggestions: [raw] });
      expect([raw, again.status, again.json]).toEqual([raw, 500, SERVER_ERROR]);
    }
    // An id the database cannot read fails the pre-fetch, and with it the batch.
    const unreadable = await suggest({ suggestions: [{ transaction_id: "nul \u0000", confidence: 0.5, label_budget_id: null }] });
    expect([unreadable.status, unreadable.json]).toEqual([500, SERVER_ERROR]);
    await stack.waitForLog('Route handler error {"method":"POST","path":"/suggest-category"}', { count: 8 });
    // One alarm a minute per route.
    expect(alarmsFor(route)).toHaveLength(1);
    expect(await labelOf(transaction_id)).toEqual([null, null, null]);
  });
});
