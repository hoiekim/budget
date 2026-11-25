import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUserClient, startStack, type ApiClient, type Stack } from "../harness";
import { seedApiKey, softDelete, storedRows, updatedLater, withInsertsDropped, type StoredRow } from "../harness/seed/budgets";
import {
  localDay,
  seedAccount,
  seedCategoryTree,
  seedInvestmentTransaction,
  seedItem,
  seedRejection,
  seedSplit,
  seedTransaction,
  setUpdated,
  shareData,
  softDeleteWhere,
  storedRejections,
  storedSplit,
  storedTransaction,
  investmentJson,
  transactionJson,
  utcToday,
} from "../harness/seed/transactions";

let stack: Stack;
/** Shares data with `partner`; never with `stranger`. */
let owner: ApiClient;
let ownerId: string;
let partner: ApiClient;
let partnerId: string;
let stranger: ApiClient;
let strangerId: string;
beforeAll(async () => {
  stack = await startStack();
  ({ client: owner, user: { user_id: ownerId } } = await createUserClient(stack, "tx-owner"));
  ({ client: partner, user: { user_id: partnerId } } = await createUserClient(stack, "tx-partner"));
  ({ client: stranger, user: { user_id: strangerId } } = await createUserClient(stack, "tx-stranger"));
  await shareData(stack, ownerId, partnerId);
});
afterAll(() => stack.stop());

const SERVER_ERROR = { status: "error", message: "Internal server error" };
const failed = (message: string) => ({ status: "failed", message });
const MANUAL_ID = /^manual-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const alarmsFor = (route: string) =>
  stack.upstream.discord.alarms().filter((alarm) => alarm.title === `🚨 Budget Server Error: Route Error: ${route}`);

/** A user of their own, signed in, so what they list is exactly what the test gave them. */
const freshUser = async (name: string): Promise<{ client: ApiClient; user_id: string }> => {
  const { client, user } = await createUserClient(stack, name);
  return { client, user_id: user.user_id };
};

/** The stored rows of the users, as the API answers them, in primary-key order. */
const listedOf = async (
  table: "transactions" | "investment_transactions",
  user_ids: string[],
  where = "TRUE",
  values: unknown[] = [],
): Promise<Record<string, unknown>[]> => {
  const key = table === "transactions" ? "transaction_id" : "investment_transaction_id";
  const owners = user_ids.map((_, i) => `$${i + 1}`).join(", ");
  const shift = (sql: string) => sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + user_ids.length}`);
  const rows = await stack.db.query<{ row: StoredRow }>(
    `SELECT to_jsonb(t) AS row FROM ${table} t WHERE t.user_id IN (${owners}) AND ${shift(where)} ORDER BY t.${key}`,
    [...user_ids, ...values],
  );
  return rows.map(({ row }) => (table === "transactions" ? transactionJson(row) : investmentJson(row)));
};

interface Listed {
  transactions: Record<string, unknown>[];
  investmentTransactions: Record<string, unknown>[];
}

describe("a caller without a session", () => {
  test("is refused on every route, and nothing is created, changed or deleted", async () => {
    const account_id = await seedAccount(stack, ownerId);
    const transaction_id = await seedTransaction(stack, ownerId, { account_id, source: "manual" });
    const before = await storedRows(stack, "transactions");
    const anonymous = stack.anonymous();
    const requests: [string, string, unknown?][] = [
      ["GET", "/transactions"],
      ["GET", `/new-transaction?account_id=${account_id}`],
      ["POST", "/transaction", { transaction_id, name: "Taken" }],
      ["DELETE", `/transaction?id=${transaction_id}`],
    ];
    for (const [method, path, body] of requests) {
      const result = await anonymous.request(method, path, { body });
      expect([method, path, result.status]).toEqual([method, path, 401]);
      expect(result.json).toEqual(failed("Not authenticated."));
    }
    expect(await storedRows(stack, "transactions")).toEqual(before);
  });

  test("is refused all the same with an API key: these routes take a session only", async () => {
    const key = await seedApiKey(stack, ownerId, ["transactions:suggest"]);
    const account_id = await seedAccount(stack, ownerId);
    const transaction_id = await seedTransaction(stack, ownerId, { account_id, source: "manual" });
    const before = await storedRows(stack, "transactions");
    const keyed = stack.anonymous();
    for (const [method, path, body] of [
      ["GET", "/transactions"],
      ["GET", `/new-transaction?account_id=${account_id}`],
      ["POST", "/transaction", { transaction_id, name: "Taken" }],
      ["DELETE", `/transaction?id=${transaction_id}`],
    ] as [string, string, unknown?][]) {
      const result = await keyed.request(method, path, { body, headers: { Authorization: `Bearer ${key}`, "X-Real-IP": "10.51.0.1" } });
      expect([method, path, result.status]).toEqual([method, path, 401]);
      expect(result.json).toEqual(failed("Not authenticated."));
    }
    expect(await storedRows(stack, "transactions")).toEqual(before);
  });
});

describe("GET /transactions", () => {
  let lister: ApiClient;
  let listerId: string;
  let memberId: string;
  let accountA: string;
  let accountB: string;
  beforeAll(async () => {
    ({ client: lister, user_id: listerId } = await freshUser("tx-lister"));
    ({ user_id: memberId } = await freshUser("tx-lister-member"));
    await shareData(stack, listerId, memberId);
    accountA = await seedAccount(stack, listerId);
    accountB = await seedAccount(stack, listerId, { type: "investment" });
    const own = await seedCategoryTree(stack, listerId);
    const member = await seedCategoryTree(stack, memberId);
    // Every nullable column set.
    await seedTransaction(stack, listerId, {
      transaction_id: "list-a-full",
      account_id: accountA,
      name: "SQ *BLUE BOTTLE",
      merchant_name: "Blue Bottle Coffee",
      amount: "-12.34",
      iso_currency_code: "USD",
      date: "2026-02-03",
      pending: true,
      pending_transaction_id: "list-a-pending-original",
      payment_channel: "online",
      location_country: "US",
      location_region: "CA",
      location_city: "Oakland",
      label_budget_id: own.budget_id,
      label_category_id: own.category_id,
      label_memo: "coffee with a friend",
      label_category_confidence: 0.5,
      raw: { personal_finance_category: { primary: "FOOD_AND_DRINK" } },
      source: "manual",
    });
    // Every nullable column unset.
    await seedTransaction(stack, listerId, {
      transaction_id: "list-b-bare",
      account_id: accountA,
      name: null,
      amount: null,
      date: "2026-02-04",
      pending: null,
    });
    await seedTransaction(stack, listerId, {
      transaction_id: "list-c-in-store",
      account_id: accountA,
      payment_channel: "in store",
      pending: false,
      label_category_id: own.category_id,
      label_category_confidence: 0,
    });
    await seedTransaction(stack, listerId, {
      transaction_id: "list-d-other",
      account_id: accountB,
      payment_channel: "other",
      label_category_id: member.category_id,
      label_budget_id: member.budget_id,
      label_category_confidence: 1,
    });
    await seedTransaction(stack, listerId, { transaction_id: "list-e-deleted", account_id: accountA, is_deleted: true });
    await seedTransaction(stack, memberId, { transaction_id: "list-f-member", account_id: "acc-member", source: "manual" });
    await seedTransaction(stack, strangerId, { transaction_id: "list-g-stranger", account_id: accountA });

    await seedInvestmentTransaction(stack, listerId, {
      investment_transaction_id: "list-inv-a-buy",
      account_id: accountB,
      security_id: "sec-listed",
      name: "Buy VTI",
      amount: "1000.5",
      quantity: "4.123456",
      price: "242.65",
      iso_currency_code: "USD",
      type: "buy",
      subtype: "buy",
      label_budget_id: own.budget_id,
      label_category_id: own.category_id,
      label_memo: "rebalance",
      source: "manual",
    });
    await seedInvestmentTransaction(stack, listerId, {
      investment_transaction_id: "list-inv-b-dividend",
      account_id: accountB,
      type: "cash",
      subtype: "dividend",
      amount: "-3.21",
    });
    await seedInvestmentTransaction(stack, listerId, { investment_transaction_id: "list-inv-c-deleted", account_id: accountA, is_deleted: true });
    await seedInvestmentTransaction(stack, memberId, { investment_transaction_id: "list-inv-d-member", account_id: "acc-member" });
    await seedInvestmentTransaction(stack, strangerId, { investment_transaction_id: "list-inv-e-stranger", account_id: accountB });
  });

  test("lists every row of the user and of their sharing group, deleted ones as tombstones, and nothing of anyone else", async () => {
    const result = await lister.get<Listed>("/transactions");
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("application/json");
    expect(result.json).toEqual({
      status: "success",
      body: {
        transactions: await listedOf("transactions", [listerId, memberId]),
        investmentTransactions: await listedOf("investment_transactions", [listerId, memberId]),
      },
    });
    expect(result.body.transactions.map((tx) => tx.transaction_id)).toEqual([
      "list-a-full",
      "list-b-bare",
      "list-c-in-store",
      "list-d-other",
      "list-e-deleted",
      "list-f-member",
    ]);
    expect(result.body.transactions[0]).toEqual({
      transaction_id: "list-a-full",
      account_id: accountA,
      name: "SQ *BLUE BOTTLE",
      merchant_name: "Blue Bottle Coffee",
      amount: -12.34,
      iso_currency_code: "USD",
      date: "2026-02-03",
      pending: true,
      pending_transaction_id: "list-a-pending-original",
      payment_channel: "online",
      label: {
        budget_id: expect.any(String),
        category_id: expect.any(String),
        memo: "coffee with a friend",
        category_confidence: 0.5,
      },
      location: { address: null, city: "Oakland", region: "CA", postal_code: null, country: "US", store_number: null, lat: null, lon: null },
      payment_meta: {
        reference_number: null,
        ppd_id: null,
        payee: null,
        by_order_of: null,
        payer: null,
        payment_method: null,
        payment_processor: null,
        reason: null,
      },
      category_id: null,
      category: null,
      account_owner: null,
      unofficial_currency_code: null,
      authorized_date: null,
      authorized_datetime: null,
      datetime: null,
      transaction_code: null,
      is_deleted: false,
      source: "manual",
    });
    expect(result.body.transactions.find((tx) => tx.transaction_id === "list-e-deleted")?.is_deleted).toBe(true);
    expect(result.body.investmentTransactions.map((tx) => tx.investment_transaction_id)).toEqual([
      "list-inv-a-buy",
      "list-inv-b-dividend",
      "list-inv-c-deleted",
      "list-inv-d-member",
    ]);
  });

  test("answers empty lists for a user with nothing", async () => {
    const { client } = await freshUser("tx-lister-empty");
    const result = await client.get("/transactions");
    expect(result.json).toEqual({ status: "success", body: { transactions: [], investmentTransactions: [] } });
  });

  test("narrows both lists to one account with account-id", async () => {
    for (const account_id of [accountA, accountB, "acc-member", "no-such-account"]) {
      const result = await lister.get<Listed>("/transactions", { query: { "account-id": account_id } });
      expect(result.json).toEqual({
        status: "success",
        body: {
          transactions: await listedOf("transactions", [listerId, memberId], "t.account_id = $1", [account_id]),
          investmentTransactions: await listedOf("investment_transactions", [listerId, memberId], "t.account_id = $1", [account_id]),
        },
      });
    }
    // An empty account-id is no filter.
    const all = await lister.get<Listed>("/transactions", { query: { "account-id": "" } });
    expect(all.body.transactions).toHaveLength(6);
  });

  test("narrows both lists by when a row last changed, not by its date, each bound inclusive", async () => {
    const { client, user_id } = await freshUser("tx-lister-dates");
    const stamps: [string, string][] = [
      ["dates-1", "2026-01-05T12:00:00.000Z"],
      ["dates-2", "2026-01-15T12:00:00.000Z"],
      ["dates-3", "2026-01-25T12:00:00.000Z"],
    ];
    for (const [id, updated] of stamps) {
      await seedTransaction(stack, user_id, { transaction_id: id, date: "2025-06-01" });
      await setUpdated(stack, "transactions", "transaction_id", id, updated);
      await seedInvestmentTransaction(stack, user_id, { investment_transaction_id: `inv-${id}`, date: "2025-06-01" });
      await setUpdated(stack, "investment_transactions", "investment_transaction_id", `inv-${id}`, updated);
    }
    const ids = async (query: Record<string, string>) => {
      const result = await client.get<Listed>("/transactions", { query });
      expect(result.json.status).toBe("success");
      return [
        result.body.transactions.map((tx) => tx.transaction_id),
        result.body.investmentTransactions.map((tx) => tx.investment_transaction_id),
      ];
    };
    const both = (...names: string[]) => [names, names.map((name) => `inv-${name}`)];
    expect(await ids({ "start-date": "2026-01-10" })).toEqual(both("dates-2", "dates-3"));
    expect(await ids({ "end-date": "2026-01-20" })).toEqual(both("dates-1", "dates-2"));
    expect(await ids({ "start-date": "2026-01-10", "end-date": "2026-01-20" })).toEqual(both("dates-2"));
    expect(await ids({ "start-date": "2026-01-15T12:00:00Z", "end-date": "2026-01-25T12:00:00Z" })).toEqual(both("dates-2", "dates-3"));
    expect(await ids({ "start-date": "2026-01-15T12:00:00.001Z" })).toEqual(both("dates-3"));
    expect(await ids({ "start-date": "2026-02-01" })).toEqual(both());
    expect(await ids({ "start-date": "", "end-date": "" })).toEqual(both("dates-1", "dates-2", "dates-3"));
  });

  test("refuses a query parameter it cannot use, checking start-date, then end-date, then both as dates, then account-id", async () => {
    const cases: [string, string][] = [
      ["?start-date=2026-01-01&start-date=2026-01-02", "Parameter start-date must be a single value, not an array"],
      ["?end-date=2026-01-01&end-date=2026-01-02", "Parameter end-date must be a single value, not an array"],
      ["?account-id=a&account-id=b", "Parameter account-id must be a single value, not an array"],
      ["?start-date=2026-02-30", "Field start-date must be a date"],
      ["?start-date=2026-13-01", "Field start-date must be a date"],
      ["?start-date=yesterday", "Field start-date must be a date"],
      ["?start-date=2026-1-5", "Field start-date must be a date"],
      ["?start-date=%20", "Field start-date must be a date"],
      ["?start-date=2026-01-05Tjunk", "Field start-date must be a date"],
      ["?end-date=2026-02-30", "Field end-date must be a date"],
      ["?end-date=01/05/2026", "Field end-date must be a date"],
      // The order of the checks.
      ["?start-date=bad&end-date=a&end-date=b", "Parameter end-date must be a single value, not an array"],
      ["?start-date=bad&end-date=bad", "Field start-date must be a date"],
      ["?account-id=a&account-id=b&end-date=bad", "Field end-date must be a date"],
    ];
    for (const [query, message] of cases) {
      const result = await lister.get(`/transactions${query}`);
      expect([query, result.status, result.json]).toEqual([query, 200, failed(message)]);
    }
  });

  test("streams a history larger than one batch whole, in primary-key order", async () => {
    const { client, user_id } = await freshUser("tx-streamer");
    await stack.db.query(
      `INSERT INTO transactions (transaction_id, user_id, account_id, name, merchant_name, amount, date, label_memo)
       SELECT 'bulk-' || lpad(g::text, 5, '0'), $1, 'acc-bulk', 'Bulk ' || g, 'Merchant ' || (g % 7), g / 100.0, DATE '2026-01-01' + (g % 300), 'memo ' || g
       FROM generate_series(1, 1203) g`,
      [user_id],
    );
    await stack.db.query(
      `INSERT INTO investment_transactions (investment_transaction_id, user_id, account_id, date, quantity, price, amount)
       SELECT 'bulk-inv-' || lpad(g::text, 5, '0'), $1, 'acc-bulk', DATE '2026-01-01', g, 1.5, g * 1.5
       FROM generate_series(1, 501) g`,
      [user_id],
    );
    const result = await client.get<Listed>("/transactions");
    expect(result.status).toBe(200);
    expect(result.body.transactions).toHaveLength(1203);
    expect(result.body.investmentTransactions).toHaveLength(501);
    expect(result.json).toEqual({
      status: "success",
      body: {
        transactions: await listedOf("transactions", [user_id]),
        investmentTransactions: await listedOf("investment_transactions", [user_id]),
      },
    });
    expect(result.body.transactions[500].transaction_id).toBe("bulk-00501");
  });

  test("a row that fails to read ends the stream after what was sent, logs it and raises an alarm", async () => {
    const route = "GET /transactions";
    const { client, user_id } = await freshUser("tx-stream-broken");
    await seedTransaction(stack, user_id, { transaction_id: "broken-1-fine" });
    await seedTransaction(stack, user_id, { transaction_id: "broken-2-raw" });
    await stack.db.query(`UPDATE transactions SET raw = '"text"'::jsonb WHERE transaction_id = 'broken-2-raw'`);
    expect(alarmsFor(route)).toHaveLength(0);
    // Read outside the recording client: the body is cut off.
    const response = await fetch(client.url("/transactions"), { headers: { Cookie: client.cookieHeader() } });
    expect(response.status).toBe(200);
    // The connection ends without completing the body: reading it fails.
    expect(await response.text().then(() => "read", () => "cut")).toBe("cut");
    await stack.waitFor(() => alarmsFor(route).length > 0, { what: `the ${route} alarm` });
    expect(alarmsFor(route).map((alarm) => alarm.description)).toEqual(['**Error:** TransactionModel validation failed:\nraw: "text" (string)']);
    await stack.waitForLog('Streamed response failed {"method":"GET","path":"/transactions"}');
  });
});

describe("POST /transaction", () => {
  let accountId: string;
  let own: { budget_id: string; section_id: string; category_id: string };
  let other: { budget_id: string; section_id: string; category_id: string };
  let partners: { budget_id: string; section_id: string; category_id: string };
  let strangers: { budget_id: string; section_id: string; category_id: string };
  beforeAll(async () => {
    accountId = await seedAccount(stack, ownerId);
    own = await seedCategoryTree(stack, ownerId);
    other = await seedCategoryTree(stack, ownerId);
    partners = await seedCategoryTree(stack, partnerId);
    strangers = await seedCategoryTree(stack, strangerId);
  });

  const target = (row: Record<string, unknown> = {}) => seedTransaction(stack, ownerId, { account_id: accountId, ...row });

  test("refuses a body it cannot use, naming the first problem, and changes nothing", async () => {
    const transaction_id = await target({ name: "Untouched", label_category_id: own.category_id, label_category_confidence: 0.5 });
    const before = await storedTransaction(stack, transaction_id);
    const id = { transaction_id };
    const cases: [unknown, string][] = [
      [undefined, "Request body is required"],
      [null, "Request body is required"],
      [[], "Request body must be an object"],
      [[{ transaction_id }], "Request body must be an object"],
      ["text", "Request body must be an object"],
      [5, "Request body must be an object"],
      [true, "Request body must be an object"],
      [false, "Request body must be an object"],
      [{}, "Missing required field: transaction_id"],
      [{ transaction_id: null }, "Missing required field: transaction_id"],
      [{ transaction_id: 5 }, "Field transaction_id must be a string"],
      [{ transaction_id: true }, "Field transaction_id must be a string"],
      [{ transaction_id: [transaction_id] }, "Field transaction_id must be a string"],
      [{ transaction_id: { id: transaction_id } }, "Field transaction_id must be a string"],
      [{ amount: "bad" }, "Missing required field: transaction_id"],
      [{ ...id, amount: "5" }, "Field amount must be a number"],
      [{ ...id, amount: null }, "Field amount must be a number"],
      [{ ...id, amount: true }, "Field amount must be a number"],
      [{ ...id, amount: [5] }, "Field amount must be a number"],
      [{ ...id, amount: {} }, "Field amount must be a number"],
      [{ ...id, amount: 10000000000000 }, "Field amount must be at most 9999999999999.99"],
      [{ ...id, amount: -10000000000000 }, "Field amount must be at most 9999999999999.99"],
      [{ ...id, amount: 1e300 }, "Field amount must be at most 9999999999999.99"],
      [{ ...id, date: null }, "Field date must be a date"],
      [{ ...id, date: 20260304 }, "Field date must be a date"],
      [{ ...id, date: "" }, "Field date must be a date"],
      [{ ...id, date: "2026-02-30" }, "Field date must be a date"],
      [{ ...id, date: "2026-13-01" }, "Field date must be a date"],
      [{ ...id, date: "03/04/2026" }, "Field date must be a date"],
      [{ ...id, date: "2026-3-4" }, "Field date must be a date"],
      [{ ...id, date: "2026-03-04Tjunk" }, "Field date must be a date"],
      [{ ...id, pending: "true" }, "Field pending must be a boolean"],
      [{ ...id, pending: 1 }, "Field pending must be a boolean"],
      [{ ...id, pending: 0 }, "Field pending must be a boolean"],
      [{ ...id, pending: [] }, "Field pending must be a boolean"],
      [{ ...id, label: "groceries" }, "Field label must be an object"],
      [{ ...id, label: 5 }, "Field label must be an object"],
      [{ ...id, label: true }, "Field label must be an object"],
      [{ ...id, label: false }, "Field label must be an object"],
      [{ ...id, label: [] }, "Field label must be an object"],
      [{ ...id, label: [{ budget_id: own.budget_id }] }, "Field label must be an object"],
      [{ ...id, label: { budget_id: "not-a-uuid" } }, "Field label.budget_id must be a uuid"],
      [{ ...id, label: { budget_id: "" } }, "Field label.budget_id must be a uuid"],
      [{ ...id, label: { budget_id: 5 } }, "Field label.budget_id must be a uuid"],
      [{ ...id, label: { budget_id: own.budget_id.replace(/-/g, "") } }, "Field label.budget_id must be a uuid"],
      [{ ...id, label: { category_id: "not-a-uuid" } }, "Field label.category_id must be a uuid"],
      [{ ...id, label: { category_id: true } }, "Field label.category_id must be a uuid"],
      [{ ...id, label: { category_id: `${own.category_id}x` } }, "Field label.category_id must be a uuid"],
      [{ ...id, label: { category_confidence: "0.5" } }, "Field label.category_confidence must be a number"],
      [{ ...id, label: { category_confidence: true } }, "Field label.category_confidence must be a number"],
      [{ ...id, label: { category_confidence: [] } }, "Field label.category_confidence must be a number"],
      // The first failing field, in the order the spec lists them.
      [{ ...id, date: "bad", amount: "bad" }, "Field amount must be a number"],
      [{ ...id, label: { category_id: "bad" }, pending: "x" }, "Field pending must be a boolean"],
      [{ ...id, label: { category_confidence: "x", budget_id: "bad" } }, "Field label.budget_id must be a uuid"],
    ];
    for (const [body, message] of cases) {
      const result = await owner.post("/transaction", body);
      expect([body, result.status, result.json]).toEqual([body, 200, failed(message)]);
    }
    expect(await storedTransaction(stack, transaction_id)).toEqual(before);
    expect(await storedRejections(stack, transaction_id)).toEqual([]);
  });

  test("writes every column it is given, and keeps the id, owner, account, source and raw provider data", async () => {
    const transaction_id = await target({ name: "Before", raw: { before: true } });
    const before = await storedTransaction(stack, transaction_id);
    const body = {
      transaction_id,
      account_id: "acc-elsewhere",
      user_id: strangerId,
      name: "Renamed",
      merchant_name: "Blue Bottle",
      amount: -42.5,
      iso_currency_code: "EUR",
      date: "2026-05-06",
      pending: true,
      pending_transaction_id: "tx-pending-before",
      payment_channel: "in store",
      location: { address: "1 Main St", city: "Oakland", region: "CA", postal_code: "94607", country: "US", lat: 1, lon: 2 },
      label: { budget_id: own.budget_id, category_id: own.category_id, memo: "lunch", category_confidence: 0.25 },
      source: "manual",
      extra: { nested: [1, 2] },
    };
    const result = await owner.post("/transaction", body);
    expect(result.json).toEqual({ status: "success", body: { transaction_id } });
    const after = await storedTransaction(stack, transaction_id);
    expect(after).toEqual({
      ...before,
      name: "Renamed",
      merchant_name: "Blue Bottle",
      amount: -42.5,
      iso_currency_code: "EUR",
      date: "2026-05-06",
      pending: true,
      pending_transaction_id: "tx-pending-before",
      payment_channel: "in store",
      location_country: "US",
      location_region: "CA",
      location_city: "Oakland",
      label_budget_id: own.budget_id,
      label_category_id: own.category_id,
      label_memo: "lunch",
      label_category_confidence: 0.25,
      updated: expect.any(String),
    });
    expect(updatedLater(after, before)).toBe(true);
  });

  test("takes the authorized date over the posted date, accepts the amount bounds, and writes null where it is given", async () => {
    const transaction_id = await target({ pending: true, label_memo: "memo", label_category_confidence: 0.7 });
    expect((await owner.post("/transaction", { transaction_id, date: "2026-05-06", authorized_date: "2026-05-01" })).json).toEqual({
      status: "success",
      body: { transaction_id },
    });
    expect((await storedTransaction(stack, transaction_id)).date).toBe("2026-05-01");

    for (const amount of [9999999999999.99, -9999999999999.99, 0, 0.01]) {
      expect((await owner.post("/transaction", { transaction_id, amount })).json.status).toBe("success");
      expect((await storedTransaction(stack, transaction_id)).amount).toBe(amount);
    }
    await owner.post("/transaction", { transaction_id, date: "2026-02-28T00:00:00" });
    expect((await storedTransaction(stack, transaction_id)).date).toBe("2026-02-28");

    await owner.post("/transaction", { transaction_id, pending: null, name: null, location: { city: null }, label: { memo: null } });
    const stored = await storedTransaction(stack, transaction_id);
    expect([stored.pending, stored.name, stored.location_city, stored.label_memo, stored.label_category_confidence]).toEqual([
      null,
      null,
      null,
      null,
      0.7,
    ]);
    // A partial update leaves every other column alone.
    const before = await storedTransaction(stack, transaction_id);
    await owner.post("/transaction", { transaction_id, merchant_name: "Only this" });
    expect(await storedTransaction(stack, transaction_id)).toEqual({ ...before, merchant_name: "Only this", updated: expect.any(String) });
    // Nothing to write (no column, a null label, a label with no fields) writes nothing, and still answers success.
    const unchanged = await storedTransaction(stack, transaction_id);
    for (const body of [{ transaction_id }, { transaction_id, label: null }, { transaction_id, label: {} }, { transaction_id, raw: { x: 1 } }]) {
      expect((await owner.post("/transaction", body)).json).toEqual({ status: "success", body: { transaction_id } });
    }
    expect(await storedTransaction(stack, transaction_id)).toEqual(unchanged);
  });

  test("infers the category confidence from what the label says, unless the label gives one", async () => {
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ category_id: "OWN" }, { label_category_id: "OWN", label_category_confidence: 1 }],
      [{ category_id: null }, { label_category_id: null, label_category_confidence: 0 }],
      [{ category_id: "OWN", category_confidence: 0.4 }, { label_category_id: "OWN", label_category_confidence: 0.4 }],
      [{ category_id: "OWN", category_confidence: null }, { label_category_id: "OWN", label_category_confidence: null }],
      [{ category_id: null, category_confidence: 0.9 }, { label_category_id: null, label_category_confidence: 0.9 }],
      [{ category_confidence: 0.3 }, { label_category_id: "OTHER", label_category_confidence: 0.3 }],
      [{ budget_id: "BUDGET" }, { label_budget_id: "BUDGET", label_category_id: "OTHER", label_category_confidence: 0.7 }],
      [{ memo: "m" }, { label_memo: "m", label_category_id: "OTHER", label_category_confidence: 0.7 }],
    ];
    const resolve = (value: unknown) =>
      value === "OWN" ? own.category_id : value === "OTHER" ? other.category_id : value === "BUDGET" ? own.budget_id : value;
    for (const [label, expected] of cases) {
      const transaction_id = await target({ label_category_id: other.category_id, label_category_confidence: 0.7 });
      const resolvedLabel = Object.fromEntries(Object.entries(label).map(([key, value]) => [key, resolve(value)]));
      const result = await owner.post("/transaction", { transaction_id, label: resolvedLabel });
      expect([label, result.json]).toEqual([label, { status: "success", body: { transaction_id } }]);
      const stored = await storedTransaction(stack, transaction_id);
      const picked = Object.fromEntries(Object.keys(expected).map((key) => [key, stored[key]]));
      expect([label, picked]).toEqual([label, Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, resolve(value)]))]);
    }
  });

  test("labels with budgets and categories of the user or their sharing group, deleted ones too, and refuses anyone else's", async () => {
    const deletedBudget = await seedCategoryTree(stack, ownerId);
    await softDelete(stack, "budgets", deletedBudget.budget_id);
    await softDelete(stack, "categories", deletedBudget.category_id);
    const accepted: Record<string, unknown>[] = [
      { budget_id: own.budget_id, category_id: own.category_id },
      { budget_id: partners.budget_id, category_id: partners.category_id },
      { budget_id: deletedBudget.budget_id, category_id: deletedBudget.category_id },
      { budget_id: null, category_id: null },
    ];
    for (const label of accepted) {
      const transaction_id = await target();
      const result = await owner.post("/transaction", { transaction_id, label });
      expect([label, result.json]).toEqual([label, { status: "success", body: { transaction_id } }]);
      const stored = await storedTransaction(stack, transaction_id);
      expect([stored.label_budget_id, stored.label_category_id]).toEqual([label.budget_id, label.category_id]);
    }
    const refused: Record<string, unknown>[] = [
      { category_id: strangers.category_id },
      { budget_id: strangers.budget_id },
      { budget_id: own.budget_id, category_id: strangers.category_id },
      { budget_id: strangers.budget_id, category_id: own.category_id },
      { category_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" },
      { budget_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" },
    ];
    for (const label of refused) {
      const transaction_id = await target({ name: "Kept" });
      const before = await storedTransaction(stack, transaction_id);
      const result = await owner.post("/transaction", { transaction_id, name: "Changed", label });
      expect([label, result.json]).toEqual([label, failed("Failed to update transaction.")]);
      expect(await storedTransaction(stack, transaction_id)).toEqual(before);
    }
  });

  test("updates a transaction of the sharing group in place, and answers success without a change for anyone else's, a missing or a deleted one", async () => {
    const partnerTx = await seedTransaction(stack, partnerId, { account_id: "acc-partner", name: "Partner's" });
    const result = await owner.post("/transaction", { transaction_id: partnerTx, name: "Renamed by owner" });
    expect(result.json).toEqual({ status: "success", body: { transaction_id: partnerTx } });
    const stored = await storedTransaction(stack, partnerTx);
    expect([stored.name, stored.user_id, stored.account_id]).toEqual(["Renamed by owner", partnerId, "acc-partner"]);
    // And the other way around.
    const ownTx = await target({ name: "Owner's" });
    await partner.post("/transaction", { transaction_id: ownTx, name: "Renamed by partner" });
    expect((await storedTransaction(stack, ownTx)).name).toBe("Renamed by partner");

    const strangerTx = await seedTransaction(stack, strangerId, { name: "Stranger's" });
    const deletedTx = await target({ name: "Deleted", is_deleted: true });
    for (const transaction_id of [strangerTx, deletedTx]) {
      const before = await storedTransaction(stack, transaction_id);
      const answer = await owner.post("/transaction", { transaction_id, name: "Taken" });
      expect(answer.json).toEqual({ status: "success", body: { transaction_id } });
      expect(await storedTransaction(stack, transaction_id)).toEqual(before);
    }
    for (const transaction_id of ["no-such-transaction", ""]) {
      const answer = await owner.post("/transaction", { transaction_id, name: "Nobody's" });
      expect(answer.json).toEqual({ status: "success", body: { transaction_id } });
    }
    expect(await stack.db.rows("transactions", { name: "Nobody's" })).toEqual([]);
    // The stranger can't reach the owner's row either.
    await stranger.post("/transaction", { transaction_id: ownTx, name: "Taken by stranger" });
    expect((await storedTransaction(stack, ownTx)).name).toBe("Renamed by partner");
  });

  describe("records category rejections for the transaction's owner", () => {
    /** Posts a label and waits for the mirror to settle, by a probe that always records one rejection after it. */
    const postAndSettle = async (client: ApiClient, body: Record<string, unknown>) => {
      const result = await client.post("/transaction", body);
      const probe = await target({ label_category_id: own.category_id, label_category_confidence: 0.5 });
      await owner.post("/transaction", { transaction_id: probe, label: { category_id: null } });
      await stack.waitFor(async () => (await storedRejections(stack, probe)).length === 1, { what: "the probe's rejection" });
      return result;
    };

    test("replacing a suggestion rejects it and clears an earlier rejection of the new category", async () => {
      const transaction_id = await target({ label_category_id: own.category_id, label_category_confidence: 0.6 });
      await seedRejection(stack, ownerId, transaction_id, other.category_id);
      const result = await postAndSettle(owner, { transaction_id, label: { category_id: other.category_id } });
      expect(result.json).toEqual({ status: "success", body: { transaction_id } });
      expect(await storedRejections(stack, transaction_id)).toEqual([[ownerId, own.category_id]]);
      const stored = await storedTransaction(stack, transaction_id);
      expect([stored.label_category_id, stored.label_category_confidence]).toEqual([other.category_id, 1]);
    });

    test("clearing a suggestion rejects it, with or without a confidence given", async () => {
      for (const label of [{ category_id: null }, { category_id: null, category_confidence: 0.5 }, { category_id: null, budget_id: null }]) {
        const transaction_id = await target({ label_category_id: own.category_id, label_category_confidence: 0.99 });
        await postAndSettle(owner, { transaction_id, label });
        expect([label, await storedRejections(stack, transaction_id)]).toEqual([label, [[ownerId, own.category_id]]]);
      }
    });

    test("replacing or clearing a confirmed, cleared or empty label rejects nothing", async () => {
      for (const confidence of [1, 0, null]) {
        for (const label of [{ category_id: other.category_id }, { category_id: null }]) {
          const transaction_id = await target({ label_category_id: own.category_id, label_category_confidence: confidence });
          await postAndSettle(owner, { transaction_id, label });
          expect([confidence, label, await storedRejections(stack, transaction_id)]).toEqual([confidence, label, []]);
        }
      }
      const unlabeled = await target({ label_category_confidence: 0.5 });
      await postAndSettle(owner, { transaction_id: unlabeled, label: { category_id: null } });
      expect(await storedRejections(stack, unlabeled)).toEqual([]);
    });

    test("choosing the suggested category again rejects nothing and clears its earlier rejection", async () => {
      const transaction_id = await target({ label_category_id: own.category_id, label_category_confidence: 0.6 });
      await seedRejection(stack, ownerId, transaction_id, own.category_id);
      await seedRejection(stack, ownerId, transaction_id, other.category_id);
      await postAndSettle(owner, { transaction_id, label: { category_id: own.category_id } });
      expect(await storedRejections(stack, transaction_id)).toEqual([[ownerId, other.category_id]]);
    });

    test("a label change that does not name the category leaves the rejections alone", async () => {
      const transaction_id = await target({ label_category_id: own.category_id, label_category_confidence: 0.6 });
      await seedRejection(stack, ownerId, transaction_id, other.category_id);
      for (const body of [
        { transaction_id, label: { budget_id: own.budget_id } },
        { transaction_id, label: { memo: "note", category_confidence: 0.2 } },
        { transaction_id, name: "No label" },
      ]) {
        await postAndSettle(owner, body);
      }
      expect(await storedRejections(stack, transaction_id)).toEqual([[ownerId, other.category_id]]);
    });

    test("a rejection on a transaction of the sharing group belongs to its owner, whoever made it", async () => {
      const transaction_id = await seedTransaction(stack, partnerId, {
        account_id: "acc-partner",
        label_category_id: partners.category_id,
        label_category_confidence: 0.6,
      });
      await postAndSettle(owner, { transaction_id, label: { category_id: own.category_id } });
      expect(await storedRejections(stack, transaction_id)).toEqual([[partnerId, partners.category_id]]);
      // Choosing it back clears the partner's row.
      await postAndSettle(owner, { transaction_id, label: { category_id: partners.category_id, category_confidence: 0.5 } });
      expect(await storedRejections(stack, transaction_id)).toEqual([]);
    });

    test("another user's transaction and its rejections stay untouched", async () => {
      const transaction_id = await seedTransaction(stack, strangerId, {
        label_category_id: strangers.category_id,
        label_category_confidence: 0.6,
      });
      await seedRejection(stack, strangerId, transaction_id, own.category_id);
      await postAndSettle(owner, { transaction_id, label: { category_id: own.category_id } });
      expect(await storedRejections(stack, transaction_id)).toEqual([[strangerId, own.category_id]]);
      expect((await storedTransaction(stack, transaction_id)).label_category_id).toBe(strangers.category_id);
    });

    test("a refused label records nothing", async () => {
      const transaction_id = await target({ label_category_id: own.category_id, label_category_confidence: 0.6 });
      const result = await postAndSettle(owner, { transaction_id, label: { category_id: strangers.category_id } });
      expect(result.json).toEqual(failed("Failed to update transaction."));
      expect(await storedRejections(stack, transaction_id)).toEqual([]);
    });

    test("a rejection that cannot be stored is logged, and the label update still succeeds", async () => {
      const transaction_id = await target({ label_category_id: own.category_id, label_category_confidence: 0.6 });
      await stack.db.query(
        "CREATE OR REPLACE FUNCTION conformance_refuse_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused by test'; END $$",
      );
      await stack.db.query(
        "CREATE TRIGGER conformance_refuse_rejection BEFORE INSERT ON rejected_categories FOR EACH ROW EXECUTE FUNCTION conformance_refuse_row()",
      );
      try {
        const result = await owner.post("/transaction", { transaction_id, label: { category_id: other.category_id } });
        expect(result.json).toEqual({ status: "success", body: { transaction_id } });
        await stack.waitForLog(`Failed to mirror category change into rejected_categories {"transactionId":"${transaction_id}"}`);
      } finally {
        await stack.db.query("DROP TRIGGER conformance_refuse_rejection ON rejected_categories");
      }
      expect(await storedRejections(stack, transaction_id)).toEqual([]);
      const stored = await storedTransaction(stack, transaction_id);
      expect([stored.label_category_id, stored.label_category_confidence]).toEqual([other.category_id, 1]);
    });
  });

  test("answers 500 and raises an alarm when the database refuses the write", async () => {
    const route = "POST /transaction";
    const transaction_id = await target({ name: "Kept" });
    const before = await storedTransaction(stack, transaction_id);
    expect(alarmsFor(route)).toHaveLength(0);
    const cases: Record<string, unknown>[] = [
      { transaction_id, name: "nul \u0000 byte" },
      { transaction_id, authorized_date: "not a date" },
      { transaction_id, iso_currency_code: "ELEVEN-CHAR" },
    ];
    for (const body of cases) {
      const result = await owner.post("/transaction", body);
      expect([body, result.status, result.json]).toEqual([body, 500, SERVER_ERROR]);
      await stack.waitFor(() => alarmsFor(route).length > 0, { what: `the ${route} alarm` });
    }
    // One alarm a minute per route.
    expect(alarmsFor(route).map((alarm) => alarm.description)).toEqual(["**Error:** Database responded with an error."]);
    await stack.waitForLog(`Failed to update transaction {"transactionId":"${transaction_id}"}`, { count: 2 * cases.length });
    await stack.waitForLog('Route handler error {"method":"POST","path":"/transaction"}', { count: cases.length });
    expect(await storedTransaction(stack, transaction_id)).toEqual(before);
  });
});

describe("DELETE /transaction", () => {
  test("refuses a missing, repeated or empty id", async () => {
    const cases: [string, string][] = [
      ["", "Missing required parameter: id"],
      ["?other=1", "Missing required parameter: id"],
      ["?id=a&id=b", "Parameter id must be a single value, not an array"],
      ["?id=", "Parameter id cannot be empty"],
      ["?id=%20%09", "Parameter id cannot be empty"],
    ];
    for (const [query, message] of cases) {
      const result = await owner.delete(`/transaction${query}`);
      expect([query, result.json]).toEqual([query, failed(message)]);
    }
  });

  test("answers not found for a missing, deleted or another user's transaction, and deletes nothing", async () => {
    const deleted = await seedTransaction(stack, ownerId, { source: "manual", is_deleted: true });
    const strangers = await seedTransaction(stack, strangerId, { source: "manual" });
    for (const id of ["no-such-transaction", deleted, strangers]) {
      const before = await storedRows(stack, "transactions", { transaction_id: id });
      const result = await owner.delete("/transaction", { query: { id } });
      expect([id, result.json]).toEqual([id, failed("Transaction not found.")]);
      expect(await storedRows(stack, "transactions", { transaction_id: id })).toEqual(before);
    }
  });

  test("refuses a transaction a provider synced", async () => {
    for (const source of ["plaid", undefined, "simple_fin"]) {
      const id = await seedTransaction(stack, ownerId, { source });
      const result = await owner.delete("/transaction", { query: { id } });
      expect([source, result.json]).toEqual([source, failed("Only manual transactions can be deleted from the detail page.")]);
      expect((await storedTransaction(stack, id)).is_deleted).toBe(false);
    }
  });

  test("soft-deletes a manual transaction with its splits and the pairs that name it, for its owner or their sharing group", async () => {
    for (const [client, rowOwner] of [
      [owner, () => ownerId],
      [partner, () => ownerId],
      [owner, () => partnerId],
    ] as [ApiClient, () => string][]) {
      const user_id = rowOwner();
      const id = await seedTransaction(stack, user_id, { source: "manual", account_id: "acc-manual" });
      const counterpart = await seedTransaction(stack, user_id, { account_id: "acc-other" });
      const liveSplit = await seedSplit(stack, user_id, { transaction_id: id });
      const otherSplit = await seedSplit(stack, user_id, { transaction_id: counterpart });
      const pairA = crypto.randomUUID();
      const pairB = crypto.randomUUID();
      await stack.db.insert("transaction_pairs", { pair_id: pairA, user_id, transaction_id_a: id, transaction_id_b: counterpart, status: "confirmed" });
      await stack.db.insert("transaction_pairs", { pair_id: pairB, user_id, transaction_id_a: counterpart, transaction_id_b: id, status: "suggested" });
      const before = await storedTransaction(stack, id);

      const result = await client.delete("/transaction", { query: { id } });
      expect(result.json).toEqual({ status: "success", body: { transaction_id: id } });
      const after = await storedTransaction(stack, id);
      expect(after).toEqual({ ...before, is_deleted: true, updated: expect.any(String) });
      expect(updatedLater(after, before)).toBe(true);
      expect((await storedSplit(stack, liveSplit)).is_deleted).toBe(true);
      expect((await storedSplit(stack, otherSplit)).is_deleted).toBe(false);
      expect((await storedTransaction(stack, counterpart)).is_deleted).toBe(false);
      const pairs = await stack.db.query<{ pair_id: string; is_deleted: boolean }>(
        "SELECT pair_id, is_deleted FROM transaction_pairs WHERE pair_id IN ($1, $2) ORDER BY created_at, pair_id",
        [pairA, pairB],
      );
      expect(pairs.map((pair) => pair.is_deleted)).toEqual([true, true]);

      // It is listed as a tombstone, and a second delete finds nothing.
      const listed = await client.get<Listed>("/transactions");
      expect(listed.body.transactions.find((tx) => tx.transaction_id === id)).toEqual(transactionJson(after));
      expect((await client.delete("/transaction", { query: { id } })).json).toEqual(failed("Transaction not found."));
    }
  });
});

describe("GET /new-transaction", () => {
  const minted = async (client: ApiClient, account_id: string) => {
    const result = await client.get<{ transaction_id: string; name: string }>("/new-transaction", { query: { account_id } });
    expect(result.status).toBe(200);
    return result;
  };

  test("refuses a missing, repeated or empty account_id", async () => {
    const cases: [string, string][] = [
      ["", "Missing required parameter: account_id"],
      ["?account-id=acc", "Missing required parameter: account_id"],
      ["?account_id=a&account_id=b", "Parameter account_id must be a single value, not an array"],
      ["?account_id=", "Parameter account_id cannot be empty"],
      ["?account_id=%20", "Parameter account_id cannot be empty"],
    ];
    for (const [query, message] of cases) {
      const result = await owner.get(`/new-transaction${query}`);
      expect([query, result.json]).toEqual([query, failed(message)]);
    }
  });

  test("answers not found for an account or item it cannot use, and refuses an account a provider syncs", async () => {
    const before = await storedRows(stack, "transactions");
    const deletedAccount = await seedAccount(stack, ownerId);
    await softDelete(stack, "accounts", deletedAccount);
    const strangersAccount = await seedAccount(stack, strangerId);
    const cases: [string, string][] = [
      ["no-such-account", "Account not found."],
      [deletedAccount, "Account not found."],
      [strangersAccount, "Account not found."],
    ];
    const deletedItem = await seedItem(stack, ownerId);
    await softDeleteWhere(stack, "items", "item_id", deletedItem);
    cases.push([await seedAccount(stack, ownerId, { item_id: "no-such-item" }), "Item not found."]);
    cases.push([await seedAccount(stack, ownerId, { item_id: deletedItem }), "Item not found."]);
    cases.push([await seedAccount(stack, ownerId, { item_id: await seedItem(stack, strangerId) }), "Item not found."]);
    for (const provider of ["plaid", "simple_fin", null, "MANUAL"]) {
      cases.push([
        await seedAccount(stack, ownerId, { item_id: await seedItem(stack, ownerId, { provider }) }),
        "Manual transaction entry is only allowed on manual accounts.",
      ]);
    }
    for (const [account_id, message] of cases) {
      const result = await owner.get("/new-transaction", { query: { account_id } });
      expect([account_id, result.json]).toEqual([account_id, failed(message)]);
    }
    expect(await storedRows(stack, "transactions")).toEqual(before);
  });

  test("mints a numbered shell on a manual account of every type, in the account's currency, owned by the caller", async () => {
    const { client, user_id } = await freshUser("tx-minter");
    const types = ["depository", "credit", "loan", "investment", "other", null];
    for (const [index, type] of types.entries()) {
      const account_id = await seedAccount(stack, user_id, { type, balances_iso_currency_code: index % 2 ? "EUR" : null });
      const result = await minted(client, account_id);
      const transaction_id = result.body.transaction_id;
      expect(transaction_id).toMatch(MANUAL_ID);
      expect(result.json).toEqual({ status: "success", body: { transaction_id, name: `Unknown_${index + 1}` } });
      const stored = await storedTransaction(stack, transaction_id);
      const today = utcToday();
      expect(stored).toEqual({
        transaction_id,
        user_id,
        account_id,
        name: `Unknown_${index + 1}`,
        merchant_name: null,
        amount: 0,
        iso_currency_code: index % 2 ? "EUR" : null,
        date: today,
        pending: false,
        pending_transaction_id: null,
        payment_channel: null,
        location_country: null,
        location_region: null,
        location_city: null,
        label_budget_id: null,
        label_category_id: null,
        label_memo: null,
        label_category_confidence: null,
        raw: {
          transaction_id,
          account_id,
          name: `Unknown_${index + 1}`,
          amount: 0,
          iso_currency_code: index % 2 ? "EUR" : null,
          date: today,
          pending: false,
        },
        updated: expect.any(String),
        is_deleted: false,
        source: "manual",
      });
      const listed = await client.get<Listed>("/transactions");
      expect(listed.body.transactions.find((tx) => tx.transaction_id === transaction_id)).toEqual(transactionJson(stored));
    }
  });

  test("numbers after the highest Unknown_N the owner ever had, deleted ones included, and nothing else", async () => {
    const { client, user_id } = await freshUser("tx-numberer");
    const account_id = await seedAccount(stack, user_id);
    for (const name of ["Unknown_x", "unknown_90", "Unknown_91 ", "Unknown_", "My Unknown_92", "Unknown_-93"]) {
      await seedTransaction(stack, user_id, { name });
    }
    expect((await minted(client, account_id)).body.name).toBe("Unknown_1");
    await seedTransaction(stack, user_id, { name: "Unknown_041", is_deleted: true });
    await seedTransaction(stack, user_id, { name: "Unknown_7" });
    // Another user's names, and investment transactions, number separately.
    await seedTransaction(stack, strangerId, { name: "Unknown_500" });
    await seedInvestmentTransaction(stack, user_id, { name: "Unknown_600" });
    expect((await minted(client, account_id)).body.name).toBe("Unknown_42");
    expect((await minted(client, account_id)).body.name).toBe("Unknown_43");
  });

  test("a shell minted on an account of the sharing group belongs to the account's owner and takes their numbering", async () => {
    const { client: memberClient, user_id: memberId } = await freshUser("tx-mint-member");
    const { client: accountOwnerClient, user_id: accountOwnerId } = await freshUser("tx-mint-account-owner");
    await shareData(stack, memberId, accountOwnerId);
    await seedTransaction(stack, accountOwnerId, { name: "Unknown_9" });
    await seedTransaction(stack, memberId, { name: "Unknown_30" });
    const account_id = await seedAccount(stack, accountOwnerId, { balances_iso_currency_code: "CAD" });
    const result = await minted(memberClient, account_id);
    expect(result.json).toEqual({ status: "success", body: { transaction_id: expect.stringMatching(MANUAL_ID), name: "Unknown_10" } });
    const stored = await storedTransaction(stack, result.body.transaction_id);
    expect([stored.user_id, stored.account_id, stored.iso_currency_code]).toEqual([accountOwnerId, account_id, "CAD"]);
    // The account owner sees it too, and can delete it.
    const deleted = await accountOwnerClient.delete("/transaction", { query: { id: result.body.transaction_id } });
    expect(deleted.json).toEqual({ status: "success", body: { transaction_id: result.body.transaction_id } });
  });

  test("answers that it failed when the insert stored no row", async () => {
    const { client, user_id } = await freshUser("tx-mint-dropped");
    const account_id = await seedAccount(stack, user_id);
    await withInsertsDropped(stack, "transactions", async () => {
      expect((await client.get("/new-transaction", { query: { account_id } })).json).toEqual(failed("Failed to create transaction."));
    });
    expect(await storedRows(stack, "transactions", { user_id })).toEqual([]);
  });

  test("a minted shell can be filled in and deleted like any manual transaction", async () => {
    const { client, user_id } = await freshUser("tx-mint-fill");
    const account_id = await seedAccount(stack, user_id);
    const { transaction_id } = (await minted(client, account_id)).body;
    expect((await client.post("/transaction", { transaction_id, name: "Coffee", amount: 4.5, date: localDay(-1) })).json).toEqual({
      status: "success",
      body: { transaction_id },
    });
    const stored = await storedTransaction(stack, transaction_id);
    expect([stored.name, stored.amount, stored.date, stored.source]).toEqual(["Coffee", 4.5, localDay(-1), "manual"]);
    expect((await client.delete("/transaction", { query: { id: transaction_id } })).json.status).toBe("success");
    // A renamed shell no longer holds its number.
    expect((await minted(client, account_id)).body.name).toBe("Unknown_1");
  });
});
