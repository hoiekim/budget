import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUserClient, startStack, type ApiClient, type Stack } from "../harness";
import { NO_SUCH_ID } from "../harness/query-cases";
import { seedApiKey, softDelete, storedRows, updatedLater, withInsertsDropped } from "../harness/seed/budgets";
import {
  investmentJson,
  seedAccount,
  seedCategoryTree,
  seedInvestmentTransaction,
  seedItem,
  seedSecurity,
  shareData,
  storedInvestmentTransaction,
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
  ({ client: owner, user: { user_id: ownerId } } = await createUserClient(stack, "inv-owner"));
  ({ client: partner, user: { user_id: partnerId } } = await createUserClient(stack, "inv-partner"));
  ({ user: { user_id: strangerId } } = await createUserClient(stack, "inv-stranger"));
  await shareData(stack, ownerId, partnerId);
});
afterAll(() => stack.stop());

const SERVER_ERROR = { status: "error", message: "Internal server error" };
const failed = (message: string) => ({ status: "failed", message });
const MANUAL_ID = /^manual-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const alarmsFor = (route: string) =>
  stack.upstream.discord.alarms().filter((alarm) => alarm.title === `🚨 Budget Server Error: Route Error: ${route}`);

const freshUser = async (name: string): Promise<{ client: ApiClient; user_id: string }> => {
  const { client, user } = await createUserClient(stack, name);
  return { client, user_id: user.user_id };
};

interface Listed {
  transactions: Record<string, unknown>[];
  investmentTransactions: Record<string, unknown>[];
}

describe("a caller without a session", () => {
  test("is refused on every route, with or without an API key, and nothing changes", async () => {
    const account_id = await seedAccount(stack, ownerId, { type: "investment" });
    const investment_transaction_id = await seedInvestmentTransaction(stack, ownerId, { account_id, source: "manual" });
    const key = await seedApiKey(stack, ownerId, ["transactions:suggest"]);
    const before = await storedRows(stack, "investment_transactions");
    const requests: [string, string, unknown?][] = [
      ["GET", `/new-investment-transaction?account_id=${account_id}`],
      ["POST", "/investment-transaction", { investment_transaction_id, name: "Taken" }],
      ["DELETE", `/investment-transaction?id=${investment_transaction_id}`],
    ];
    for (const headers of [{}, { Authorization: `Bearer ${key}`, "X-Real-IP": "10.53.0.1" }] as Record<string, string>[]) {
      for (const [method, path, body] of requests) {
        const result = await stack.anonymous().request(method, path, { body, headers });
        expect([method, path, result.status, result.json]).toEqual([method, path, 401, failed("Not authenticated.")]);
      }
    }
    expect(await storedRows(stack, "investment_transactions")).toEqual(before);
  });
});

describe("POST /investment-transaction", () => {
  let own: { budget_id: string; category_id: string };
  let strangers: { budget_id: string; category_id: string };
  beforeAll(async () => {
    own = await seedCategoryTree(stack, ownerId);
    strangers = await seedCategoryTree(stack, strangerId);
  });

  const target = (row: Record<string, unknown> = {}) => seedInvestmentTransaction(stack, ownerId, { account_id: "acc-brokerage", ...row });

  test("refuses a body it cannot use, naming the first problem, and changes nothing", async () => {
    const investment_transaction_id = await target({ name: "Untouched" });
    const before = await storedInvestmentTransaction(stack, investment_transaction_id);
    const id = { investment_transaction_id };
    const cases: [unknown, string][] = [
      [undefined, "Request body is required"],
      [null, "Request body is required"],
      [[], "Request body must be an object"],
      ["x", "Request body must be an object"],
      [false, "Request body must be an object"],
      [{}, "Missing required field: investment_transaction_id"],
      [{ investment_transaction_id: null }, "Missing required field: investment_transaction_id"],
      [{ price: "x" }, "Missing required field: investment_transaction_id"],
      [{ investment_transaction_id: 1 }, "Field investment_transaction_id must be a string"],
      [{ investment_transaction_id: {} }, "Field investment_transaction_id must be a string"],
      [{ ...id, amount: "1" }, "Field amount must be a number"],
      [{ ...id, amount: null }, "Field amount must be a number"],
      [{ ...id, amount: 10000000000000 }, "Field amount must be at most 9999999999999.99"],
      [{ ...id, quantity: "1" }, "Field quantity must be a number"],
      [{ ...id, quantity: null }, "Field quantity must be a number"],
      [{ ...id, quantity: 1000000000 }, "Field quantity must be at most 999999999.999999"],
      [{ ...id, quantity: -1000000000 }, "Field quantity must be at most 999999999.999999"],
      [{ ...id, price: true }, "Field price must be a number"],
      [{ ...id, price: [] }, "Field price must be a number"],
      [{ ...id, price: 1000000000.5 }, "Field price must be at most 999999999.999999"],
      [{ ...id, price: -1e10 }, "Field price must be at most 999999999.999999"],
      [{ ...id, date: null }, "Field date must be a date"],
      [{ ...id, date: "2026-04-31" }, "Field date must be a date"],
      [{ ...id, date: "April 1" }, "Field date must be a date"],
      [{ ...id, label: 1 }, "Field label must be an object"],
      [{ ...id, label: [] }, "Field label must be an object"],
      [{ ...id, label: { budget_id: "bad" } }, "Field label.budget_id must be a uuid"],
      [{ ...id, label: { budget_id: 1 } }, "Field label.budget_id must be a uuid"],
      [{ ...id, label: { category_id: "bad" } }, "Field label.category_id must be a uuid"],
      [{ ...id, label: { category_id: {} } }, "Field label.category_id must be a uuid"],
      // The first failing field, in the spec's order: amount, quantity, price, date, label.
      [{ ...id, price: "x", quantity: "x", amount: "x" }, "Field amount must be a number"],
      [{ ...id, price: "x", quantity: "x" }, "Field quantity must be a number"],
      [{ ...id, date: "x", price: "x" }, "Field price must be a number"],
      [{ ...id, label: { category_id: "bad" }, date: "x" }, "Field date must be a date"],
    ];
    for (const [body, message] of cases) {
      const result = await owner.post("/investment-transaction", body);
      expect([body, result.status, result.json]).toEqual([body, 200, failed(message)]);
    }
    expect(await storedInvestmentTransaction(stack, investment_transaction_id)).toEqual(before);
  });

  test("writes every column it is given but never the id, owner or provenance, and accepts the bounds", async () => {
    const investment_transaction_id = await target({ source: "plaid", raw: { from: "plaid" } });
    const before = await storedInvestmentTransaction(stack, investment_transaction_id);
    const security_id = await seedSecurity(stack, { ticker_symbol: "VTI" });
    const result = await owner.post("/investment-transaction", {
      investment_transaction_id,
      user_id: strangerId,
      account_id: "acc-moved",
      security_id,
      date: "2026-06-01",
      name: "Bought VTI",
      amount: -9999999999999.99,
      quantity: -999999999.999999,
      price: 999999999.999999,
      iso_currency_code: "USD",
      type: "buy",
      subtype: "buy",
      label: { budget_id: own.budget_id, category_id: own.category_id, memo: "rebalance", category_confidence: "ignored" },
      source: "manual",
      fees: 1.5,
    });
    expect(result.json).toEqual({ status: "success", body: { investment_transaction_id } });
    const after = await storedInvestmentTransaction(stack, investment_transaction_id);
    expect(after).toEqual({
      ...before,
      account_id: "acc-moved",
      security_id,
      date: "2026-06-01",
      name: "Bought VTI",
      amount: -9999999999999.99,
      quantity: -999999999.999999,
      price: 999999999.999999,
      iso_currency_code: "USD",
      type: "buy",
      subtype: "buy",
      label_budget_id: own.budget_id,
      label_category_id: own.category_id,
      label_memo: "rebalance",
      updated: expect.any(String),
    });
    expect([after.source, after.raw, after.user_id]).toEqual(["plaid", { from: "plaid" }, ownerId]);
    expect(updatedLater(after, before)).toBe(true);

    // Clearing, and a source alone, which changes nothing.
    await owner.post("/investment-transaction", { investment_transaction_id, security_id: null, label: { budget_id: null, category_id: null, memo: null } });
    const cleared = await storedInvestmentTransaction(stack, investment_transaction_id);
    expect([cleared.security_id, cleared.label_budget_id, cleared.label_category_id, cleared.label_memo]).toEqual([null, null, null, null]);
    for (const body of [{ investment_transaction_id, source: "manual" }, { investment_transaction_id }, { investment_transaction_id, label: {} }]) {
      expect((await owner.post("/investment-transaction", body)).json).toEqual({ status: "success", body: { investment_transaction_id } });
    }
    expect(await storedInvestmentTransaction(stack, investment_transaction_id)).toEqual(cleared);
  });

  test("stores every type and subtype as given", async () => {
    const pairs: [string, string][] = [
      ["buy", "buy"],
      ["buy", "contribution"],
      ["sell", "sell"],
      ["sell", "fee"],
      ["cash", "dividend"],
      ["cash", "interest"],
      ["fee", "management fee"],
      ["transfer", "transfer"],
      ["cancel", "cancel"],
      ["unknown kind", "unknown subtype"],
    ];
    for (const [type, subtype] of pairs) {
      const investment_transaction_id = await target();
      expect((await owner.post("/investment-transaction", { investment_transaction_id, type, subtype, quantity: 0, price: 0 })).json.status).toBe(
        "success",
      );
      const stored = await storedInvestmentTransaction(stack, investment_transaction_id);
      expect([stored.type, stored.subtype, stored.quantity, stored.price]).toEqual([type, subtype, 0, 0]);
    }
  });

  test("takes any well-formed budget or category as a label, another user's included", async () => {
    const investment_transaction_id = await target();
    for (const label of [
      { budget_id: strangers.budget_id, category_id: strangers.category_id },
      { budget_id: NO_SUCH_ID, category_id: NO_SUCH_ID },
    ]) {
      expect((await owner.post("/investment-transaction", { investment_transaction_id, label })).json.status).toBe("success");
      const stored = await storedInvestmentTransaction(stack, investment_transaction_id);
      expect([stored.label_budget_id, stored.label_category_id]).toEqual([label.budget_id, label.category_id]);
    }
  });

  test("updates a row of the sharing group, and answers success without a change for anyone else's, a missing or a deleted one", async () => {
    const partners = await seedInvestmentTransaction(stack, partnerId, { name: "Partner's" });
    expect((await owner.post("/investment-transaction", { investment_transaction_id: partners, name: "By owner" })).json).toEqual({
      status: "success",
      body: { investment_transaction_id: partners },
    });
    const stored = await storedInvestmentTransaction(stack, partners);
    expect([stored.name, stored.user_id]).toEqual(["By owner", partnerId]);
    const owners = await target({ name: "Owner's" });
    await partner.post("/investment-transaction", { investment_transaction_id: owners, name: "By partner" });
    expect((await storedInvestmentTransaction(stack, owners)).name).toBe("By partner");

    const strangers = await seedInvestmentTransaction(stack, strangerId, { name: "Stranger's" });
    const deleted = await target({ name: "Deleted", is_deleted: true });
    for (const investment_transaction_id of [strangers, deleted]) {
      const before = await storedInvestmentTransaction(stack, investment_transaction_id);
      expect((await owner.post("/investment-transaction", { investment_transaction_id, name: "Taken" })).json).toEqual({
        status: "success",
        body: { investment_transaction_id },
      });
      expect(await storedInvestmentTransaction(stack, investment_transaction_id)).toEqual(before);
    }
    for (const investment_transaction_id of ["no-such-row", ""]) {
      expect((await owner.post("/investment-transaction", { investment_transaction_id, name: "Nobody's" })).json).toEqual({
        status: "success",
        body: { investment_transaction_id },
      });
    }
  });

  test("answers 500 and raises an alarm when the database refuses the write", async () => {
    const route = "POST /investment-transaction";
    const investment_transaction_id = await target({ name: "Kept" });
    const before = await storedInvestmentTransaction(stack, investment_transaction_id);
    expect(alarmsFor(route)).toHaveLength(0);
    for (const body of [
      { investment_transaction_id, name: "nul \u0000" },
      { investment_transaction_id, iso_currency_code: "ELEVEN-CHAR" },
      { investment_transaction_id, security_id: "s".repeat(256) },
    ]) {
      const result = await owner.post("/investment-transaction", body);
      expect([result.status, result.json]).toEqual([500, SERVER_ERROR]);
      await stack.waitFor(() => alarmsFor(route).length > 0, { what: `the ${route} alarm` });
    }
    expect(alarmsFor(route).map((alarm) => alarm.description)).toEqual(["**Error:** Database responded with an error."]);
    await stack.waitForLog(`Failed to update investment transaction {"investmentTransactionId":"${investment_transaction_id}"}`, { count: 6 });
    expect(await storedInvestmentTransaction(stack, investment_transaction_id)).toEqual(before);
  });
});

describe("DELETE /investment-transaction", () => {
  test("refuses a missing, repeated or empty id", async () => {
    const cases: [string, string][] = [
      ["", "Missing required parameter: id"],
      ["?ID=x", "Missing required parameter: id"],
      ["?id=a&id=b", "Parameter id must be a single value, not an array"],
      ["?id=", "Parameter id cannot be empty"],
      ["?id=%0A", "Parameter id cannot be empty"],
    ];
    for (const [query, message] of cases) {
      expect([query, (await owner.delete(`/investment-transaction${query}`)).json]).toEqual([query, failed(message)]);
    }
  });

  test("answers not found for a missing, deleted or another user's row, and refuses a synced one", async () => {
    const deleted = await seedInvestmentTransaction(stack, ownerId, { source: "manual", is_deleted: true });
    const strangers = await seedInvestmentTransaction(stack, strangerId, { source: "manual" });
    for (const id of ["no-such-row", deleted, strangers]) {
      expect([id, (await owner.delete("/investment-transaction", { query: { id } })).json]).toEqual([
        id,
        failed("Investment transaction not found."),
      ]);
    }
    for (const source of ["plaid", undefined]) {
      const id = await seedInvestmentTransaction(stack, ownerId, { source });
      expect((await owner.delete("/investment-transaction", { query: { id } })).json).toEqual(
        failed("Only manual investment transactions can be deleted from the detail page."),
      );
      expect((await storedInvestmentTransaction(stack, id)).is_deleted).toBe(false);
    }
  });

  test("soft-deletes a manual row of the user or their sharing group", async () => {
    for (const [client, user_id] of [
      [owner, () => ownerId],
      [owner, () => partnerId],
      [partner, () => ownerId],
    ] as [ApiClient, () => string][]) {
      const id = await seedInvestmentTransaction(stack, user_id(), { source: "manual", account_id: "acc-brokerage" });
      const before = await storedInvestmentTransaction(stack, id);
      expect((await client.delete("/investment-transaction", { query: { id } })).json).toEqual({
        status: "success",
        body: { investment_transaction_id: id },
      });
      const after = await storedInvestmentTransaction(stack, id);
      expect(after).toEqual({ ...before, is_deleted: true, updated: expect.any(String) });
      expect(updatedLater(after, before)).toBe(true);
      const listed = await client.get<Listed>("/transactions");
      expect(listed.body.investmentTransactions.find((tx) => tx.investment_transaction_id === id)).toEqual(investmentJson(after));
      expect((await client.delete("/investment-transaction", { query: { id } })).json).toEqual(failed("Investment transaction not found."));
    }
  });
});

describe("GET /new-investment-transaction", () => {
  let accountId: string;
  let securityId: string;
  beforeAll(async () => {
    accountId = await seedAccount(stack, ownerId, { type: "investment" });
    securityId = await seedSecurity(stack, { ticker_symbol: "VTI" });
  });

  const mint = (client: ApiClient, query: Record<string, string | string[]>) =>
    client.get<{ investment_transaction_id: string; name: string }>("/new-investment-transaction", { query });

  test("refuses a missing, repeated or empty account_id before anything else", async () => {
    const cases: [string, string][] = [
      ["", "Missing required parameter: account_id"],
      ["?price=bad", "Missing required parameter: account_id"],
      ["?account_id=a&account_id=b&price=bad", "Parameter account_id must be a single value, not an array"],
      ["?account_id=&date=bad", "Parameter account_id cannot be empty"],
      ["?account_id=%20", "Parameter account_id cannot be empty"],
    ];
    for (const [query, message] of cases) {
      expect([query, (await owner.get(`/new-investment-transaction${query}`)).json]).toEqual([query, failed(message)]);
    }
  });

  test("refuses a mint value it cannot store before looking anything up, in the order date, currency, price, quantity", async () => {
    const before = await storedRows(stack, "investment_transactions");
    const cases: [Record<string, string | string[]>, string][] = [
      [{ date: "2026-02-30" }, "Field date must be a date"],
      [{ date: "02/03/2026" }, "Field date must be a date"],
      [{ date: " " }, "Field date must be a date"],
      [{ date: ["2026-01-01", "2026-01-02"] }, "Field date must be a date"],
      [{ iso_currency_code: "ABCDEFGHIJK" }, "Field iso_currency_code must be at most 10 characters"],
      [{ iso_currency_code: ["USD", "EUR"] }, "Field iso_currency_code must be a string"],
      [{ price: "abc" }, "Field price must be a number"],
      [{ price: "1,000" }, "Field price must be a number"],
      [{ price: "Infinity" }, "Field price must be a number"],
      [{ price: "1e400" }, "Field price must be a number"],
      [{ price: ["1", "2"] }, "Field price must be a number"],
      [{ price: "-1" }, "Field price must be at least 0"],
      [{ price: "-0.000001" }, "Field price must be at least 0"],
      [{ price: "1000000000" }, "Field price must be at most 999999999.999999"],
      [{ price: "-1000000000" }, "Field price must be at most 999999999.999999"],
      [{ quantity: "ten" }, "Field quantity must be a number"],
      [{ quantity: "-Infinity" }, "Field quantity must be a number"],
      [{ quantity: "1000000000" }, "Field quantity must be at most 999999999.999999"],
      [{ quantity: "-1000000000" }, "Field quantity must be at most 999999999.999999"],
      [{ quantity: ["1", "2"] }, "Field quantity must be a number"],
      [{ quantity: "x", price: "x", iso_currency_code: "ABCDEFGHIJK", date: "x" }, "Field date must be a date"],
      [{ quantity: "x", price: "x", iso_currency_code: "ABCDEFGHIJK" }, "Field iso_currency_code must be at most 10 characters"],
      [{ quantity: "x", price: "x" }, "Field price must be a number"],
    ];
    for (const [query, message] of cases) {
      // On an account that does not exist: the values are checked first.
      for (const account_id of [accountId, "no-such-account"]) {
        const result = await mint(owner, { account_id, ...query });
        expect([query, account_id, result.json]).toEqual([query, account_id, failed(message)]);
      }
    }
    expect(await storedRows(stack, "investment_transactions")).toEqual(before);
  });

  test("answers not found for an account it cannot use, refuses an account that is not an investment account, and an unknown security", async () => {
    const before = await storedRows(stack, "investment_transactions");
    const deleted = await seedAccount(stack, ownerId, { type: "investment" });
    await softDelete(stack, "accounts", deleted);
    for (const account_id of ["no-such-account", deleted, await seedAccount(stack, strangerId, { type: "investment" })]) {
      expect([account_id, (await mint(owner, { account_id })).json]).toEqual([account_id, failed("Account not found.")]);
    }
    for (const type of ["depository", "credit", "loan", "other", "brokerage", "Investment", null]) {
      const account_id = await seedAccount(stack, ownerId, { type });
      expect([type, (await mint(owner, { account_id, security_id: "no-such-security" })).json]).toEqual([
        type,
        failed("Investment transactions can only be created on investment accounts."),
      ]);
    }
    for (const security_id of ["no-such-security", [securityId, securityId], `${securityId} `]) {
      expect([security_id, (await mint(owner, { account_id: accountId, security_id })).json]).toEqual([
        security_id,
        failed("Security not found."),
      ]);
    }
    expect(await storedRows(stack, "investment_transactions")).toEqual(before);
  });

  test("mints a numbered buy of today with the defaults, on a manual or a provider's investment account", async () => {
    const { client, user_id } = await freshUser("inv-minter");
    const plaidAccount = await seedAccount(stack, user_id, { type: "investment", item_id: await seedItem(stack, user_id, { provider: "plaid" }) });
    const manualAccount = await seedAccount(stack, user_id, { type: "investment" });
    for (const [index, account_id] of [plaidAccount, manualAccount].entries()) {
      const result = await mint(client, { account_id });
      const investment_transaction_id = result.body.investment_transaction_id;
      expect(investment_transaction_id).toMatch(MANUAL_ID);
      expect(result.json).toEqual({ status: "success", body: { investment_transaction_id, name: `Unknown_${index + 1}` } });
      const today = utcToday();
      const stored = await storedInvestmentTransaction(stack, investment_transaction_id);
      expect(stored).toEqual({
        investment_transaction_id,
        user_id,
        account_id,
        security_id: null,
        date: today,
        name: `Unknown_${index + 1}`,
        amount: 0,
        quantity: 0,
        price: 0,
        iso_currency_code: null,
        type: "buy",
        subtype: "buy",
        label_budget_id: null,
        label_category_id: null,
        label_memo: null,
        raw: {
          investment_transaction_id,
          account_id,
          security_id: null,
          date: today,
          name: `Unknown_${index + 1}`,
          amount: 0,
          quantity: 0,
          price: 0,
          iso_currency_code: null,
          type: "buy",
          subtype: "buy",
        },
        updated: expect.any(String),
        is_deleted: false,
        source: "manual",
      });
      const listed = await client.get<Listed>("/transactions");
      expect(listed.body.investmentTransactions.find((tx) => tx.investment_transaction_id === investment_transaction_id)).toEqual(
        investmentJson(stored),
      );
    }
  });

  test("prefills what it is given, derives the amount, and takes only buy or sell as the type", async () => {
    const { client, user_id } = await freshUser("inv-prefill");
    const account_id = await seedAccount(stack, user_id, { type: "investment" });
    const cases: [Record<string, string | string[]>, Record<string, unknown>][] = [
      [
        { security_id: securityId, price: "10.005", quantity: "3", iso_currency_code: "CAD", date: "2025-12-31", type: "sell" },
        { security_id: securityId, price: 10.005, quantity: 3, amount: 30.02, iso_currency_code: "CAD", date: "2025-12-31", type: "sell", subtype: "sell" },
      ],
      [{ quantity: "-2", price: "12.5", type: "sell" }, { quantity: -2, price: 12.5, amount: -25, type: "sell", subtype: "sell" }],
      [{ quantity: "-2", price: "12.5" }, { quantity: -2, amount: -25, type: "buy", subtype: "buy" }],
      [{ quantity: "5" }, { quantity: 5, price: 0, amount: 0 }],
      [{ price: "7" }, { quantity: 0, price: 7, amount: 0 }],
      [{ type: "buy" }, { type: "buy", subtype: "buy" }],
      [{ type: "dividend" }, { type: "buy", subtype: "buy" }],
      [{ type: "SELL" }, { type: "buy", subtype: "buy" }],
      [{ type: ["sell", "sell"] }, { type: "buy", subtype: "buy" }],
      [{ type: "" }, { type: "buy", subtype: "buy" }],
      [{ date: "2026-01-05T10:00:00" }, { date: "2026-01-05" }],
      [{ date: "", iso_currency_code: "", price: "", quantity: "", security_id: "" }, { date: utcToday(), iso_currency_code: null, price: 0, quantity: 0, security_id: null }],
      [{ price: "999999999.999999", quantity: "0.000001" }, { price: 999999999.999999, quantity: 0.000001, amount: 1000 }],
      [{ price: "0", quantity: "-999999999.999999" }, { price: 0, quantity: -999999999.999999, amount: 0 }],
      [{ price: "0x10", quantity: " 2 " }, { price: 16, quantity: 2, amount: 32 }],
      [{ price: "1e2", quantity: ".5" }, { price: 100, quantity: 0.5, amount: 50 }],
      [{ price: "0b11", quantity: "0o7" }, { price: 3, quantity: 7, amount: 21 }],
      [{ price: "-0", quantity: "0" }, { price: 0, quantity: 0, amount: 0 }],
      [{ iso_currency_code: "ABCDEFGHIJ" }, { iso_currency_code: "ABCDEFGHIJ" }],
    ];
    for (const [index, [query, expected]] of cases.entries()) {
      const result = await mint(client, { account_id, ...query });
      expect([query, result.json]).toEqual([
        query,
        { status: "success", body: { investment_transaction_id: expect.stringMatching(MANUAL_ID), name: `Unknown_${index + 1}` } },
      ]);
      const stored = await storedInvestmentTransaction(stack, result.body.investment_transaction_id);
      const picked = Object.fromEntries(Object.keys(expected).map((key) => [key, stored[key]]));
      expect([query, picked]).toEqual([query, expected]);
    }
    // Each value in bounds, their product past the amount column's: the insert fails, and no number is taken.
    const overflow = await mint(client, { account_id, price: "999999999.999999", quantity: "-999999999.999999" });
    expect(overflow.json).toEqual(failed("Failed to create investment transaction."));
    await stack.waitForLog("Failed to create manual investment transaction");
    expect((await mint(client, { account_id })).body.name).toBe(`Unknown_${cases.length + 1}`);
  });

  test("numbers after the owner's highest Unknown_N among investment transactions, deleted ones included", async () => {
    const { client, user_id } = await freshUser("inv-numberer");
    const account_id = await seedAccount(stack, user_id, { type: "investment" });
    await seedInvestmentTransaction(stack, user_id, { name: "Unknown_19", is_deleted: true });
    await seedInvestmentTransaction(stack, user_id, { name: "Unknown_twenty" });
    await seedInvestmentTransaction(stack, strangerId, { name: "Unknown_99" });
    await stack.db.insert("transactions", { transaction_id: "inv-numberer-tx", user_id, account_id, name: "Unknown_50", date: "2026-01-01" });
    expect((await mint(client, { account_id })).body.name).toBe("Unknown_20");
    expect((await mint(client, { account_id })).body.name).toBe("Unknown_21");
  });

  test("a row minted on an account of the sharing group belongs to the account's owner and takes their numbering", async () => {
    const { client: memberClient, user_id: memberId } = await freshUser("inv-mint-member");
    const { user_id: accountOwnerId } = await freshUser("inv-mint-account-owner");
    await shareData(stack, memberId, accountOwnerId);
    await seedInvestmentTransaction(stack, accountOwnerId, { name: "Unknown_4" });
    await seedInvestmentTransaction(stack, memberId, { name: "Unknown_40" });
    const account_id = await seedAccount(stack, accountOwnerId, { type: "investment" });
    const result = await mint(memberClient, { account_id, price: "2", quantity: "3" });
    expect(result.json).toEqual({
      status: "success",
      body: { investment_transaction_id: expect.stringMatching(MANUAL_ID), name: "Unknown_5" },
    });
    const stored = await storedInvestmentTransaction(stack, result.body.investment_transaction_id);
    expect([stored.user_id, stored.account_id, stored.amount]).toEqual([accountOwnerId, account_id, 6]);
  });

  test("answers that it failed when the insert stored no row", async () => {
    const { client, user_id } = await freshUser("inv-mint-dropped");
    const account_id = await seedAccount(stack, user_id, { type: "investment" });
    await withInsertsDropped(stack, "investment_transactions", async () => {
      expect((await mint(client, { account_id })).json).toEqual(failed("Failed to create investment transaction."));
    });
    expect(await storedRows(stack, "investment_transactions", { user_id })).toEqual([]);
  });
});
