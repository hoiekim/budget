import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUserClient, startStack, type ApiClient, type Stack } from "../harness";
import { NO_SUCH_ID, uuidQueryCases } from "../harness/query-cases";
import { seedApiKey, storedRows, updatedLater, withInsertsDropped, type StoredRow } from "../harness/seed/budgets";
import {
  seedCategoryTree,
  seedSplit,
  seedTransaction,
  setUpdated,
  shareData,
  splitJson,
  storedSplit,
  storedTransaction,
  utcToday,
} from "../harness/seed/transactions";

let stack: Stack;
/** Shares data with `partner`; never with `stranger`. */
let owner: ApiClient;
let ownerId: string;
let partner: ApiClient;
let partnerId: string;
let strangerId: string;
beforeAll(async () => {
  stack = await startStack();
  ({ client: owner, user: { user_id: ownerId } } = await createUserClient(stack, "split-owner"));
  ({ client: partner, user: { user_id: partnerId } } = await createUserClient(stack, "split-partner"));
  ({ user: { user_id: strangerId } } = await createUserClient(stack, "split-stranger"));
  await shareData(stack, ownerId, partnerId);
});
afterAll(() => stack.stop());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SERVER_ERROR = { status: "error", message: "Internal server error" };
const failed = (message: string) => ({ status: "failed", message });

const alarmsFor = (route: string) =>
  stack.upstream.discord.alarms().filter((alarm) => alarm.title === `🚨 Budget Server Error: Route Error: ${route}`);

const freshUser = async (name: string): Promise<{ client: ApiClient; user_id: string }> => {
  const { client, user } = await createUserClient(stack, name);
  return { client, user_id: user.user_id };
};

/** Splits in the order the route answers them: newest date first, ties by id so the comparison is stable. */
const byDateThenId = (rows: Record<string, unknown>[]) =>
  [...rows].sort((a, b) =>
    String(a.date) === String(b.date)
      ? String(a.split_transaction_id).localeCompare(String(b.split_transaction_id))
      : String(b.date).localeCompare(String(a.date)),
  );

const storedSplitsOf = async (user_ids: string[], where = "TRUE", values: unknown[] = []): Promise<Record<string, unknown>[]> => {
  const owners = user_ids.map((_, i) => `$${i + 1}`).join(", ");
  const shift = (sql: string) => sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + user_ids.length}`);
  const rows = await stack.db.query<{ row: StoredRow }>(
    `SELECT to_jsonb(t) AS row FROM split_transactions t WHERE t.user_id IN (${owners}) AND ${shift(where)}`,
    [...user_ids, ...values],
  );
  return byDateThenId(rows.map(({ row }) => splitJson(row)));
};

describe("a caller without a session", () => {
  test("is refused on every route, with or without an API key, and nothing changes", async () => {
    const transaction_id = await seedTransaction(stack, ownerId);
    const split_transaction_id = await seedSplit(stack, ownerId, { transaction_id });
    const key = await seedApiKey(stack, ownerId, ["transactions:suggest"]);
    const before = await storedRows(stack, "split_transactions");
    const requests: [string, string, unknown?][] = [
      ["GET", "/split-transactions"],
      ["GET", `/new-split-transaction?transaction_id=${transaction_id}&account_id=acc`],
      ["POST", "/split-transaction", { split_transaction_id, amount: 1 }],
      ["DELETE", `/split-transaction?id=${split_transaction_id}`],
    ];
    for (const headers of [{}, { Authorization: `Bearer ${key}`, "X-Real-IP": "10.52.0.1" }] as Record<string, string>[]) {
      for (const [method, path, body] of requests) {
        const result = await stack.anonymous().request(method, path, { body, headers });
        expect([method, path, result.status, result.json]).toEqual([method, path, 401, failed("Not authenticated.")]);
      }
    }
    expect(await storedRows(stack, "split_transactions")).toEqual(before);
  });
});

describe("GET /split-transactions", () => {
  let lister: ApiClient;
  let listerId: string;
  let memberId: string;
  beforeAll(async () => {
    ({ client: lister, user_id: listerId } = await freshUser("split-lister"));
    ({ user_id: memberId } = await freshUser("split-lister-member"));
    await shareData(stack, listerId, memberId);
    const tree = await seedCategoryTree(stack, listerId);
    await seedSplit(stack, listerId, {
      transaction_id: "tx-parent-a",
      account_id: "acc-a",
      amount: "12.5",
      date: "2026-03-05",
      custom_name: "Groceries part",
      label_budget_id: tree.budget_id,
      label_category_id: tree.category_id,
      label_memo: "memo",
      label_category_confidence: 0.75,
    });
    await seedSplit(stack, listerId, { transaction_id: "tx-parent-a", account_id: "acc-a", amount: null, date: "2026-03-01", custom_name: null });
    await seedSplit(stack, listerId, { transaction_id: "tx-parent-b", account_id: "acc-b", date: "2026-03-09", label_category_confidence: 1 });
    await seedSplit(stack, listerId, { transaction_id: "tx-parent-b", account_id: "acc-b", date: "2026-03-03", is_deleted: true });
    await seedSplit(stack, memberId, { transaction_id: "tx-member", account_id: "acc-member", date: "2026-03-07", label_category_confidence: 0 });
    await seedSplit(stack, strangerId, { transaction_id: "tx-stranger", account_id: "acc-a", date: "2026-03-08" });
  });

  test("lists the splits of the user and their sharing group, newest first, deleted ones as tombstones", async () => {
    const result = await lister.get<Record<string, unknown>[]>("/split-transactions");
    expect(result.status).toBe(200);
    expect(result.json.status).toBe("success");
    expect(result.body).toEqual(await storedSplitsOf([listerId, memberId]));
    expect(result.body.map((split) => split.date)).toEqual(["2026-03-09", "2026-03-07", "2026-03-05", "2026-03-03", "2026-03-01"]);
    expect(result.body[2]).toEqual({
      split_transaction_id: expect.stringMatching(UUID),
      transaction_id: "tx-parent-a",
      account_id: "acc-a",
      amount: 12.5,
      date: "2026-03-05",
      custom_name: "Groceries part",
      label: { budget_id: expect.stringMatching(UUID), category_id: expect.stringMatching(UUID), memo: "memo", category_confidence: 0.75 },
      is_deleted: false,
    });
    expect(result.body[3].is_deleted).toBe(true);
  });

  test("answers an empty list for a user with no splits", async () => {
    const { client } = await freshUser("split-lister-empty");
    expect((await client.get("/split-transactions")).json).toEqual({ status: "success", body: [] });
  });

  test("narrows to one account with account-id", async () => {
    for (const account_id of ["acc-a", "acc-b", "acc-member", "acc-none"]) {
      const result = await lister.get("/split-transactions", { query: { "account-id": account_id } });
      expect(result.json).toEqual({
        status: "success",
        body: await storedSplitsOf([listerId, memberId], "t.account_id = $1", [account_id]),
      });
    }
    expect((await lister.get<unknown[]>("/split-transactions", { query: { "account-id": "" } })).body).toHaveLength(5);
  });

  test("narrows by when a split last changed, each bound inclusive", async () => {
    const { client, user_id } = await freshUser("split-lister-dates");
    const ids: string[] = [];
    for (const [day, updated] of [
      ["2025-01-01", "2026-01-05T12:00:00.000Z"],
      ["2025-01-02", "2026-01-15T12:00:00.000Z"],
      ["2025-01-03", "2026-01-25T12:00:00.000Z"],
    ]) {
      const id = await seedSplit(stack, user_id, { date: day });
      await setUpdated(stack, "split_transactions", "split_transaction_id", id, updated);
      ids.push(id);
    }
    const listed = async (query: Record<string, string>) =>
      (await client.get<{ split_transaction_id: string }[]>("/split-transactions", { query })).body.map((s) => s.split_transaction_id);
    // Newest date first.
    expect(await listed({ "start-date": "2026-01-10" })).toEqual([ids[2], ids[1]]);
    expect(await listed({ "end-date": "2026-01-20" })).toEqual([ids[1], ids[0]]);
    expect(await listed({ "start-date": "2026-01-10", "end-date": "2026-01-20" })).toEqual([ids[1]]);
    expect(await listed({ "start-date": "2026-01-15T12:00:00Z", "end-date": "2026-01-25T12:00:00Z" })).toEqual([ids[2], ids[1]]);
    expect(await listed({ "end-date": "2026-01-05T11:59:59Z" })).toEqual([]);
    expect(await listed({ "start-date": "", "end-date": "" })).toEqual([ids[2], ids[1], ids[0]]);
  });

  test("refuses a query parameter it cannot use, in the order it checks them", async () => {
    const cases: [string, string][] = [
      ["?start-date=a&start-date=b", "Parameter start-date must be a single value, not an array"],
      ["?end-date=a&end-date=b", "Parameter end-date must be a single value, not an array"],
      ["?account-id=a&account-id=b", "Parameter account-id must be a single value, not an array"],
      ["?start-date=2026-02-30", "Field start-date must be a date"],
      ["?start-date=tomorrow", "Field start-date must be a date"],
      ["?end-date=2026-00-10", "Field end-date must be a date"],
      ["?end-date=%20", "Field end-date must be a date"],
      ["?start-date=bad&end-date=a&end-date=b", "Parameter end-date must be a single value, not an array"],
      ["?end-date=bad&account-id=a&account-id=b", "Field end-date must be a date"],
    ];
    for (const [query, message] of cases) {
      const result = await lister.get(`/split-transactions${query}`);
      expect([query, result.json]).toEqual([query, failed(message)]);
    }
  });
});

describe("POST /split-transaction", () => {
  let own: { budget_id: string; category_id: string };
  let strangers: { budget_id: string; category_id: string };
  beforeAll(async () => {
    own = await seedCategoryTree(stack, ownerId);
    strangers = await seedCategoryTree(stack, strangerId);
  });

  const target = (row: Record<string, unknown> = {}) => seedSplit(stack, ownerId, { transaction_id: "tx-split-parent", ...row });

  test("refuses a body it cannot use, naming the first problem, and changes nothing", async () => {
    const split_transaction_id = await target({ custom_name: "Untouched" });
    const before = await storedSplit(stack, split_transaction_id);
    const id = { split_transaction_id };
    const cases: [unknown, string][] = [
      [undefined, "Request body is required"],
      [null, "Request body is required"],
      [[], "Request body must be an object"],
      ["split", "Request body must be an object"],
      [7, "Request body must be an object"],
      [{}, "Missing required field: split_transaction_id"],
      [{ split_transaction_id: null }, "Missing required field: split_transaction_id"],
      [{ amount: 1 }, "Missing required field: split_transaction_id"],
      [{ split_transaction_id: 5 }, "Field split_transaction_id must be a string"],
      [{ split_transaction_id: [split_transaction_id] }, "Field split_transaction_id must be a string"],
      [{ split_transaction_id: "not-a-uuid" }, "Field split_transaction_id must be a uuid"],
      [{ split_transaction_id: "" }, "Field split_transaction_id must be a uuid"],
      [{ split_transaction_id: split_transaction_id.replace(/-/g, "") }, "Field split_transaction_id must be a uuid"],
      [{ ...id, transaction_id: 5 }, "Field transaction_id must be a string"],
      [{ ...id, transaction_id: null }, "Field transaction_id must be a string"],
      [{ ...id, transaction_id: "t".repeat(256) }, "Field transaction_id must be at most 255 characters"],
      [{ ...id, transaction_id: "é".repeat(256) }, "Field transaction_id must be at most 255 characters"],
      [{ ...id, amount: "1" }, "Field amount must be a number"],
      [{ ...id, amount: null }, "Field amount must be a number"],
      [{ ...id, amount: 10000000000000 }, "Field amount must be at most 9999999999999.99"],
      [{ ...id, amount: -10000000000000 }, "Field amount must be at most 9999999999999.99"],
      [{ ...id, date: null }, "Field date must be a date"],
      [{ ...id, date: "2026-02-29" }, "Field date must be a date"],
      [{ ...id, date: 1 }, "Field date must be a date"],
      [{ ...id, label: "x" }, "Field label must be an object"],
      [{ ...id, label: [] }, "Field label must be an object"],
      [{ ...id, label: { budget_id: "x" } }, "Field label.budget_id must be a uuid"],
      [{ ...id, label: { category_id: 1 } }, "Field label.category_id must be a uuid"],
      [{ ...id, label: { category_confidence: "1" } }, "Field label.category_confidence must be a number"],
      [{ ...id, label: { category_confidence: false } }, "Field label.category_confidence must be a number"],
      [{ ...id, amount: "x", transaction_id: 5 }, "Field transaction_id must be a string"],
      [{ ...id, date: "x", amount: "x" }, "Field amount must be a number"],
      [{ split_transaction_id: "bad", transaction_id: 5 }, "Field split_transaction_id must be a uuid"],
    ];
    for (const [body, message] of cases) {
      const result = await owner.post("/split-transaction", body);
      expect([body, result.status, result.json]).toEqual([body, 200, failed(message)]);
    }
    expect(await storedSplit(stack, split_transaction_id)).toEqual(before);
  });

  test("writes every column it is given, keeps the id and owner, and accepts the bounds", async () => {
    const split_transaction_id = await target();
    const before = await storedSplit(stack, split_transaction_id);
    const result = await owner.post("/split-transaction", {
      split_transaction_id,
      user_id: strangerId,
      transaction_id: "t".repeat(255),
      account_id: "acc-moved",
      amount: -9999999999999.99,
      date: "2026-04-30T00:00:00",
      custom_name: "Dinner part",
      label: { budget_id: own.budget_id, category_id: own.category_id, memo: "split memo", category_confidence: 0.33 },
      ignored: true,
    });
    expect(result.json).toEqual({ status: "success", body: { split_transaction_id } });
    const after = await storedSplit(stack, split_transaction_id);
    expect(after).toEqual({
      ...before,
      transaction_id: "t".repeat(255),
      account_id: "acc-moved",
      amount: -9999999999999.99,
      date: "2026-04-30",
      custom_name: "Dinner part",
      label_budget_id: own.budget_id,
      label_category_id: own.category_id,
      label_memo: "split memo",
      label_category_confidence: 0.33,
      updated: expect.any(String),
    });
    expect(updatedLater(after, before)).toBe(true);

    await owner.post("/split-transaction", { split_transaction_id, amount: 9999999999999.99, custom_name: null, label: { memo: null } });
    const cleared = await storedSplit(stack, split_transaction_id);
    expect([cleared.amount, cleared.custom_name, cleared.label_memo, cleared.label_category_confidence]).toEqual([
      9999999999999.99,
      null,
      null,
      0.33,
    ]);
    // Nothing to write writes nothing, and still answers success.
    for (const body of [{ split_transaction_id }, { split_transaction_id, label: null }, { split_transaction_id, label: {} }]) {
      expect((await owner.post("/split-transaction", body)).json).toEqual({ status: "success", body: { split_transaction_id } });
    }
    expect(await storedSplit(stack, split_transaction_id)).toEqual(cleared);
  });

  test("infers the category confidence the way a transaction's label does", async () => {
    const cases: [Record<string, unknown>, unknown][] = [
      [{ category_id: "OWN" }, 1],
      [{ category_id: null }, 0],
      [{ category_id: "OWN", category_confidence: 0.6 }, 0.6],
      [{ category_id: "OWN", category_confidence: null }, null],
      [{ budget_id: "BUDGET" }, 0.7],
      [{ category_confidence: 0.2 }, 0.2],
    ];
    const resolve = (value: unknown) => (value === "OWN" ? own.category_id : value === "BUDGET" ? own.budget_id : value);
    for (const [label, confidence] of cases) {
      const split_transaction_id = await target({ label_category_confidence: 0.7 });
      const resolved = Object.fromEntries(Object.entries(label).map(([key, value]) => [key, resolve(value)]));
      expect((await owner.post("/split-transaction", { split_transaction_id, label: resolved })).json.status).toBe("success");
      const stored = await storedSplit(stack, split_transaction_id);
      expect([label, stored.label_category_confidence]).toEqual([label, confidence]);
      if ("category_id" in resolved) expect(stored.label_category_id).toBe(resolved.category_id as string | null);
    }
  });

  test("takes any well-formed budget or category as a label, another user's included: splits check no label owner", async () => {
    const split_transaction_id = await target();
    for (const label of [
      { budget_id: strangers.budget_id, category_id: strangers.category_id },
      { budget_id: NO_SUCH_ID, category_id: NO_SUCH_ID },
    ]) {
      expect((await owner.post("/split-transaction", { split_transaction_id, label })).json).toEqual({
        status: "success",
        body: { split_transaction_id },
      });
      const stored = await storedSplit(stack, split_transaction_id);
      expect([stored.label_budget_id, stored.label_category_id]).toEqual([label.budget_id, label.category_id]);
    }
  });

  test("updates a split of the sharing group, and answers success without a change for anyone else's, a missing or a deleted one", async () => {
    const partners = await seedSplit(stack, partnerId, { custom_name: "Partner's" });
    expect((await owner.post("/split-transaction", { split_transaction_id: partners, custom_name: "By owner" })).json).toEqual({
      status: "success",
      body: { split_transaction_id: partners },
    });
    const stored = await storedSplit(stack, partners);
    expect([stored.custom_name, stored.user_id]).toEqual(["By owner", partnerId]);
    const owners = await target({ custom_name: "Owner's" });
    await partner.post("/split-transaction", { split_transaction_id: owners, custom_name: "By partner" });
    expect((await storedSplit(stack, owners)).custom_name).toBe("By partner");

    const strangers = await seedSplit(stack, strangerId, { custom_name: "Stranger's" });
    const deleted = await target({ custom_name: "Deleted", is_deleted: true });
    for (const split_transaction_id of [strangers, deleted]) {
      const before = await storedSplit(stack, split_transaction_id);
      expect((await owner.post("/split-transaction", { split_transaction_id, custom_name: "Taken" })).json).toEqual({
        status: "success",
        body: { split_transaction_id },
      });
      expect(await storedSplit(stack, split_transaction_id)).toEqual(before);
    }
    expect((await owner.post("/split-transaction", { split_transaction_id: NO_SUCH_ID, amount: 1 })).json).toEqual({
      status: "success",
      body: { split_transaction_id: NO_SUCH_ID },
    });
  });

  test("answers 500 and raises an alarm when the database refuses the write", async () => {
    const route = "POST /split-transaction";
    const split_transaction_id = await target({ custom_name: "Kept" });
    const before = await storedSplit(stack, split_transaction_id);
    expect(alarmsFor(route)).toHaveLength(0);
    for (const body of [
      { split_transaction_id, custom_name: "nul \u0000" },
      { split_transaction_id, account_id: "a".repeat(256) },
    ]) {
      const result = await owner.post("/split-transaction", body);
      expect([result.status, result.json]).toEqual([500, SERVER_ERROR]);
      await stack.waitFor(() => alarmsFor(route).length > 0, { what: `the ${route} alarm` });
    }
    expect(alarmsFor(route).map((alarm) => alarm.description)).toEqual(["**Error:** Database responded with an error."]);
    await stack.waitForLog(`Failed to update split transaction {"splitTransactionId":"${split_transaction_id}"}`, { count: 4 });
    expect(await storedSplit(stack, split_transaction_id)).toEqual(before);
  });
});

describe("DELETE /split-transaction", () => {
  test("refuses an id that is missing, repeated, empty or not a UUID", async () => {
    for (const [query, message] of uuidQueryCases("id")) {
      const result = await owner.delete(`/split-transaction${query}`);
      expect([query, result.json]).toEqual([query, failed(message)]);
    }
  });

  test("answers not found for a missing or another user's split", async () => {
    const strangers = await seedSplit(stack, strangerId);
    for (const id of [NO_SUCH_ID, strangers]) {
      const before = await storedRows(stack, "split_transactions", { split_transaction_id: id });
      expect((await owner.delete("/split-transaction", { query: { id } })).json).toEqual(failed("Split transaction not found."));
      expect(await storedRows(stack, "split_transactions", { split_transaction_id: id })).toEqual(before);
    }
  });

  test("deletes an already deleted split again: the delete matches tombstones and bumps their change time", async () => {
    const deleted = await seedSplit(stack, ownerId, { is_deleted: true });
    const before = await storedSplit(stack, deleted);
    expect((await owner.delete("/split-transaction", { query: { id: deleted } })).json).toEqual({ status: "success" });
    const after = await storedSplit(stack, deleted);
    expect(after).toEqual({ ...before, updated: expect.any(String) });
    expect(updatedLater(after, before)).toBe(true);
  });

  test("soft-deletes a split of the user or their sharing group, whatever its parent", async () => {
    for (const [client, user_id] of [
      [owner, () => ownerId],
      [owner, () => partnerId],
      [partner, () => ownerId],
    ] as [ApiClient, () => string][]) {
      const parent = await seedTransaction(stack, user_id(), { source: "plaid" });
      const id = await seedSplit(stack, user_id(), { transaction_id: parent });
      const sibling = await seedSplit(stack, user_id(), { transaction_id: parent });
      const before = await storedSplit(stack, id);
      const result = await client.delete("/split-transaction", { query: { id } });
      expect(result.json).toEqual({ status: "success" });
      const after = await storedSplit(stack, id);
      expect(after).toEqual({ ...before, is_deleted: true, updated: expect.any(String) });
      expect(updatedLater(after, before)).toBe(true);
      expect((await storedSplit(stack, sibling)).is_deleted).toBe(false);
      expect((await storedTransaction(stack, parent)).is_deleted).toBe(false);
      const listed = await client.get<Record<string, unknown>[]>("/split-transactions");
      expect(listed.body.find((split) => split.split_transaction_id === id)).toEqual(splitJson(after));
    }
  });

  test("deleting a manual parent transaction deletes the group's splits of it, bumping tombstones too", async () => {
    const parent = await seedTransaction(stack, ownerId, { source: "manual" });
    const live = await seedSplit(stack, ownerId, { transaction_id: parent });
    const partnersSplit = await seedSplit(stack, partnerId, { transaction_id: parent });
    const strangersSplit = await seedSplit(stack, strangerId, { transaction_id: parent });
    const alreadyDeleted = await seedSplit(stack, ownerId, { transaction_id: parent, is_deleted: true });
    const deletedBefore = await storedSplit(stack, alreadyDeleted);
    expect((await owner.delete("/transaction", { query: { id: parent } })).json).toEqual({ status: "success", body: { transaction_id: parent } });
    expect((await storedSplit(stack, live)).is_deleted).toBe(true);
    expect((await storedSplit(stack, partnersSplit)).is_deleted).toBe(true);
    expect((await storedSplit(stack, strangersSplit)).is_deleted).toBe(false);
    const deletedAfter = await storedSplit(stack, alreadyDeleted);
    expect(deletedAfter).toEqual({ ...deletedBefore, updated: expect.any(String) });
    expect(updatedLater(deletedAfter, deletedBefore)).toBe(true);
  });
});

describe("GET /new-split-transaction", () => {
  test("refuses a missing, repeated or empty transaction_id or account_id, transaction_id first", async () => {
    const cases: [string, string][] = [
      ["", "Missing required parameter: transaction_id"],
      ["?account_id=acc", "Missing required parameter: transaction_id"],
      ["?transaction_id=a&transaction_id=b&account_id=acc", "Parameter transaction_id must be a single value, not an array"],
      ["?transaction_id=&account_id=acc", "Parameter transaction_id cannot be empty"],
      ["?transaction_id=%20&account_id=", "Parameter transaction_id cannot be empty"],
      ["?transaction_id=tx", "Missing required parameter: account_id"],
      ["?transaction_id=tx&account_id=a&account_id=b", "Parameter account_id must be a single value, not an array"],
      ["?transaction_id=tx&account_id=", "Parameter account_id cannot be empty"],
      ["?transaction_id=tx&account_id=%09", "Parameter account_id cannot be empty"],
    ];
    for (const [query, message] of cases) {
      const result = await owner.get(`/new-split-transaction${query}`);
      expect([query, result.json]).toEqual([query, failed(message)]);
    }
  });

  test("answers not found for a missing, deleted or another user's transaction", async () => {
    const deleted = await seedTransaction(stack, ownerId, { is_deleted: true });
    const strangers = await seedTransaction(stack, strangerId);
    const before = await storedRows(stack, "split_transactions");
    for (const transaction_id of ["no-such-transaction", deleted, strangers]) {
      const result = await owner.get("/new-split-transaction", { query: { transaction_id, account_id: "acc" } });
      expect([transaction_id, result.json]).toEqual([transaction_id, failed("Transaction not found.")]);
    }
    expect(await storedRows(stack, "split_transactions")).toEqual(before);
  });

  test("mints an empty split of today, owned by the transaction's owner, on the account it is given", async () => {
    for (const [client, user_id] of [
      [owner, () => ownerId],
      [owner, () => partnerId],
      [partner, () => ownerId],
    ] as [ApiClient, () => string][]) {
      const transaction_id = await seedTransaction(stack, user_id(), { account_id: "acc-parent", amount: "40" });
      const result = await client.get<{ split_transaction_id: string }>("/new-split-transaction", {
        query: { transaction_id, account_id: "acc-given" },
      });
      expect(result.json).toEqual({ status: "success", body: { split_transaction_id: expect.stringMatching(UUID) } });
      const split_transaction_id = result.body.split_transaction_id;
      expect(await storedSplit(stack, split_transaction_id)).toEqual({
        split_transaction_id,
        user_id: user_id(),
        transaction_id,
        account_id: "acc-given",
        amount: 0,
        date: utcToday(),
        custom_name: "",
        label_budget_id: null,
        label_category_id: null,
        label_memo: null,
        label_category_confidence: null,
        updated: expect.any(String),
        is_deleted: false,
      });
      const listed = await client.get<Record<string, unknown>[]>("/split-transactions");
      expect(listed.body.find((split) => split.split_transaction_id === split_transaction_id)).toEqual(
        splitJson(await storedSplit(stack, split_transaction_id)),
      );
      // Filled in through the update route.
      expect((await client.post("/split-transaction", { split_transaction_id, amount: 15.25 })).json.status).toBe("success");
      expect((await storedSplit(stack, split_transaction_id)).amount).toBe(15.25);
    }
  });

  test("answers 500 and raises an alarm when the insert stores no row", async () => {
    const route = "GET /new-split-transaction";
    const transaction_id = await seedTransaction(stack, ownerId);
    expect(alarmsFor(route)).toHaveLength(0);
    await withInsertsDropped(stack, "split_transactions", async () => {
      const result = await owner.get("/new-split-transaction", { query: { transaction_id, account_id: "acc" } });
      expect([result.status, result.json]).toEqual([500, SERVER_ERROR]);
    });
    await stack.waitFor(() => alarmsFor(route).length > 0, { what: `the ${route} alarm` });
    expect(alarmsFor(route).map((alarm) => alarm.description)).toEqual(["**Error:** Failed to create split transaction"]);
    expect(await storedRows(stack, "split_transactions", { transaction_id })).toEqual([]);
  });
});
