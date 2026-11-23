/**
 * The plan-statement import, `POST /plan-statement/import`: who may call it,
 * every check made of the request the import page builds from a
 * recordkeeper's statement (its shape, the account, each planned row, the
 * securities), and the rows it stores, leaves alone or stops on. What it
 * saves beside the rows, the events it sends, the price backfill it starts
 * and the failures it rolls back are in `plan-statement-effects.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startStack, type Stack } from "../harness";
import { seedApiKey } from "../harness/seed/budgets";
import {
  rowOf,
  rowsOf,
  seedHoldingSnapshot,
  seedInvestmentTransaction,
  seedItem,
  shareData,
  softDeleteRow,
  type ItemProvider,
} from "../harness/seed/accounts";
import {
  cashLeg,
  cashSecurity,
  importBody,
  importPlanStatement as post,
  planAccount,
  planId,
  planPerson,
  savedMappings,
  shareLeg,
  storedHolding,
  storedTransaction,
  withoutStamps,
  type Fields,
  type PlannedRow,
} from "../harness/seed/plan-statement";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

const failed = (message: string) => ({ status: "failed", message });
const success = (body: Record<string, unknown>) => ({ status: "success", body });
const NOT_FOUND = failed("Account not found.");
const NOT_MANUAL = failed("Plan statements can only be imported into a manual investment account.");

const person = (name: string) => planPerson(stack, name);
const account = (user_id: string, item_id: string, row: Fields = {}) => planAccount(stack, user_id, item_id, row);
const mappingsOf = (account_id: string) => savedMappings(stack, account_id);
const storedRows = async (table: string, where: Record<string, unknown>) => (await rowsOf(stack, table, where)).map(withoutStamps);
const idOf = (planned: PlannedRow) => planned.transaction.investment_transaction_id as string;

// ---------------------------------------------------------------------------
// Who may call it
// ---------------------------------------------------------------------------

describe("a caller without a session", () => {
  test("is refused, with or without an API key, and nothing is stored", async () => {
    const owner = await person("anon");
    const security_id = await cashSecurity(stack);
    const body = importBody(owner.account_id, [shareLeg(owner.account_id, security_id)]);
    const key = await seedApiKey(stack, owner.user_id, ["transactions:suggest", "budgets:read", "budgets:write"]);
    for (const headers of [{}, { Authorization: `Bearer ${key}`, "X-Real-IP": "10.61.0.1" }] as Record<string, string>[]) {
      const result = await post(stack.anonymous(), body, { headers });
      expect(result.status).toBe(401);
      expect(result.json).toEqual(failed("Not authenticated."));
    }
    expect(await storedRows("investment_transactions", { account_id: owner.account_id })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The shape of the request
// ---------------------------------------------------------------------------

describe("a body that is not an import request", () => {
  const base = { account_id: "no-such-account", transactions: [], mappings: [], holdings: [] };
  const parsable = { investment_transaction_id: "x", date: "2026-03-02" };
  const holding = { security_id: "s", date: "2026-03-02", quantity: 2, cost_basis: 100, price: 50 };

  test("is refused when it is not an object", async () => {
    const { client } = await person("body");
    for (const [body, message] of [
      [null, "Request body is required"],
      [[], "Request body must be an object"],
      ["text", "Request body must be an object"],
      [7, "Request body must be an object"],
      [true, "Request body must be an object"],
    ] as const) {
      expect([body, (await post(client, body)).json]).toEqual([body, failed(message)]);
    }
    expect((await client.request("POST", "/plan-statement/import")).json).toEqual(failed("Request body is required"));
  });

  test("is refused with what is wrong first, field by field, before anything is looked up", async () => {
    const { client } = await person("shape");
    const transactionsWith = (transaction: unknown) => ({ ...base, transactions: [{ transaction }] });
    const cases: [unknown, string][] = [
      // The account comes first.
      [{}, "Missing required field: account_id"],
      [{ ...base, account_id: null }, "Missing required field: account_id"],
      ...[5, true, [], {}, ["acc"]].map((account_id): [unknown, string] => [{ ...base, account_id }, "Field account_id must be a string"]),
      [{ account_id: 5, transactions: "x" }, "Field account_id must be a string"],
      // Then the planned rows, each needing a transaction with an id and a calendar date.
      [{ account_id: "a" }, "transactions must be an array"],
      ...[null, "x", 5, {}, true].map((transactions): [unknown, string] => [{ ...base, transactions }, "transactions must be an array"]),
      [{ ...base, transactions: "x", mappings: "x" }, "transactions must be an array"],
      ...[null, 5, "x", [], {}, [{ transaction: parsable }], { transaction: null }, { transaction: [] }, { transaction: "x" }, { transaction: 5 }].map(
        (planned): [unknown, string] => [{ ...base, transactions: [planned] }, "each transaction needs a transaction object"],
      ),
      ...[undefined, null, "", 5, ["x"], {}, true].map((id): [unknown, string] => [
        transactionsWith({ investment_transaction_id: id, date: "2026-03-02" }),
        "each transaction needs an id",
      ]),
      [transactionsWith({ date: 5 }), "each transaction needs an id"],
      ...[
        undefined,
        null,
        20260302,
        "20260302",
        "2026-3-02",
        "2026-02-30",
        "2026-02-29",
        "1900-02-29",
        "2026-13-01",
        "2026-00-10",
        "2026-03-32",
        "2026-03-00",
        // A year below 100 is read as 19xx by the calendar check, so it never matches.
        "0050-01-01",
        "0000-01-01",
        "2026-03-02T00:00:00Z",
        " 2026-03-02",
        "2026-03-02 ",
        "2026-03-02\n",
        "+02026-03-02",
        "２０２６-03-02",
        "٢٠٢٦-٠٣-٠٢",
        ["2026-03-02"],
      ].map((date): [unknown, string] => [transactionsWith({ investment_transaction_id: "x", date }), "each transaction needs a YYYY-MM-DD date"]),
      ...[null, 5, "x", [], true, false, 0, ""].map((restated_from): [unknown, string] => [
        { ...base, transactions: [{ transaction: parsable, restated_from }] },
        "restated_from must be an object",
      ]),
      // Row by row: a good row does not excuse a bad one after it.
      [{ ...base, transactions: [{ transaction: parsable }, { transaction: { investment_transaction_id: "y" } }] }, "each transaction needs a YYYY-MM-DD date"],
      [{ ...base, transactions: [{ transaction: parsable }, null] }, "each transaction needs a transaction object"],
      [{ ...base, transactions: [{ transaction: { date: "x" } }], mappings: "x" }, "each transaction needs an id"],
      // Then the fund mappings.
      [{ account_id: "a", transactions: [] }, "mappings must be an array"],
      ...[null, "x", 5, {}].map((mappings): [unknown, string] => [{ ...base, mappings }, "mappings must be an array"]),
      [{ ...base, mappings: "x", replace: 5 }, "mappings must be an array"],
      ...[null, 5, "x", [], {}, { investment: "" }, { investment: 5 }, { investment: null, security_id: "s", restated: true }, { security_id: "s", restated: true }].map(
        (mapping): [unknown, string] => [{ ...base, mappings: [mapping] }, "each mapping needs an investment"],
      ),
      ...[{ investment: "F" }, { investment: "F", security_id: "" }, { investment: "F", security_id: 5 }, { investment: "F", security_id: null, restated: false }].map(
        (mapping): [unknown, string] => [{ ...base, mappings: [mapping] }, "each mapping needs a security_id"],
      ),
      ...[undefined, null, "true", 1, 0, []].map((restated): [unknown, string] => [
        { ...base, mappings: [{ investment: "F", security_id: "s", restated }] },
        "mapping restated must be a boolean",
      ]),
      [{ ...base, mappings: [{ investment: "F", security_id: "s", restated: true }, null], replace: "x" }, "each mapping needs an investment"],
      // Then the securities whose entered positions are replaced: absent or null is none.
      ...["x", 5, {}, true, [1], [""], [null], ["s", ""], [["s"]], [{}]].map((replace): [unknown, string] => [
        { ...base, replace },
        "replace must be an array of security ids",
      ]),
      [{ ...base, replace: "x", holdings: "x" }, "replace must be an array of security ids"],
      // Then the holdings, each with a security, a calendar date and its figures.
      [{ account_id: "a", transactions: [], mappings: [] }, "holdings must be an array"],
      ...[null, "x", 5, {}].map((holdings): [unknown, string] => [{ ...base, holdings }, "holdings must be an array"]),
      ...[null, 5, "x", [], {}, { ...holding, security_id: "" }, { ...holding, security_id: 5 }, { ...holding, security_id: undefined }].map(
        (h): [unknown, string] => [{ ...base, holdings: [h] }, "each holding needs a security_id"],
      ),
      ...[undefined, null, 20260302, "2026-02-30", "2026-13-01", "2026-00-10", "2026-03-32", "2026-03-02T00:00:00Z"].map((date): [unknown, string] => [
        { ...base, holdings: [{ ...holding, date }] },
        "each holding needs a YYYY-MM-DD date",
      ]),
      ...[
        { quantity: undefined },
        { quantity: null },
        { quantity: "2" },
        { quantity: true },
        { price: undefined },
        { price: null },
        { price: "50" },
        // The cost basis is a number or null, never left out. A figure past the range of a
        // double (`1e999`) is left out here: how the Rust server reads one is a known gap of
        // its body parser, handled on its own.
        { cost_basis: undefined },
        { cost_basis: "100" },
        { cost_basis: false },
        { cost_basis: [] },
      ].map((fields): [unknown, string] => [{ ...base, holdings: [{ ...holding, ...fields }] }, "each holding needs a quantity, a price and a cost basis or null"]),
      [{ ...base, holdings: [holding, { ...holding, date: "x" }] }, "each holding needs a YYYY-MM-DD date"],
    ];
    for (const [body, message] of cases) {
      const result = await post(client, body);
      expect([body, result.status, result.json]).toEqual([body, 200, failed(message)]);
    }
  });

  test("passes on to the account when its shape is right, whatever the rows say", async () => {
    const { client } = await person("parsable");
    for (const body of [
      base,
      { ...base, account_id: "" },
      { ...base, replace: null },
      { ...base, replace: [] },
      { ...base, replace: ["s", "s"] },
      { ...base, extra: "ignored" },
      // A restatement is any object here; what is in it is checked against the account.
      { ...base, transactions: [{ transaction: parsable, restated_from: {} }] },
      { ...base, transactions: [{ transaction: parsable, reinvested_distribution: "anything" }] },
      { ...base, transactions: [{ transaction: { investment_transaction_id: " ", date: "2024-02-29" } }] },
      { ...base, transactions: [{ transaction: { investment_transaction_id: "x", date: "2000-02-29", amount: "not checked yet" } }] },
      { ...base, mappings: [{ investment: " ", security_id: " ", restated: false, extra: 1 }] },
      { ...base, holdings: [{ security_id: "s", date: "2026-03-02", quantity: 0, cost_basis: null, price: -1 }] },
      { ...base, holdings: [{ security_id: "s", date: "2026-03-02", quantity: 1e300, cost_basis: -1e-300, price: 0.5, extra: true }] },
    ]) {
      expect([body, (await post(client, body)).json]).toEqual([body, NOT_FOUND]);
    }
  });
});

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

describe("the account", () => {
  test("is refused when it is missing, deleted or a stranger's, before any row is read", async () => {
    const [owner, stranger] = [await person("acct"), await person("acct-stranger")];
    const deleted = await account(owner.user_id, owner.item_id);
    await softDeleteRow(stack, "accounts", deleted);
    const security_id = await cashSecurity(stack);
    for (const account_id of ["no-such-account", "", deleted, stranger.account_id]) {
      // The rows are wrong too; the account is what is named.
      const body = importBody(account_id, [shareLeg(account_id, security_id, { investment_transaction_id: "manual-1" })], { replace: ["no-such-security"] });
      expect([account_id, (await post(owner.client, body)).json]).toEqual([account_id, NOT_FOUND]);
    }
    expect(await storedRows("investment_transactions", { account_id: stranger.account_id })).toEqual([]);
    expect(await mappingsOf(stranger.account_id)).toBeNull();
  });

  test("must be an investment account of a manual connection", async () => {
    const owner = await person("kind");
    const security_id = await cashSecurity(stack);
    const under = async (provider: ItemProvider, row: Fields = {}) => account(owner.user_id, await seedItem(stack, owner.user_id, provider), row);
    const deletedItem = await seedItem(stack, owner.user_id, "manual");
    const stranger = await person("kind-stranger");
    const refused = [
      await under("plaid"),
      await under("simple_fin"),
      await under("manual", { type: "depository", subtype: "checking" }),
      await under("manual", { type: "credit", subtype: "credit card" }),
      await under("manual", { type: "loan", subtype: "student" }),
      await under("manual", { type: null, subtype: null }),
      await under("manual", { type: "Investment" }),
      // A connection that is deleted, missing, or someone else's is no manual connection of the owner.
      await account(owner.user_id, deletedItem),
      await account(owner.user_id, "no-such-item"),
      await account(owner.user_id, stranger.item_id),
    ];
    await softDeleteRow(stack, "items", deletedItem);
    for (const account_id of refused) {
      // The account is checked before its rows.
      const body = importBody(account_id, [shareLeg(account_id, security_id, { investment_transaction_id: "manual-1" })]);
      expect([account_id, (await post(owner.client, body)).json]).toEqual([account_id, NOT_MANUAL]);
      expect(await storedRows("investment_transactions", { account_id })).toEqual([]);
      expect(await mappingsOf(account_id)).toBeNull();
    }
  });

  test("of someone in the caller's sharing group takes the rows, all stored as its owner's", async () => {
    const [caller, owner, stranger] = [await person("member"), await person("member-owner"), await person("member-stranger")];
    await shareData(stack, caller.user_id, owner.user_id);
    const security_id = await cashSecurity(stack);
    const entered = await seedHoldingSnapshot(stack, owner.user_id, owner.account_id, security_id);
    const share = shareLeg(owner.account_id, security_id);
    const cash = cashLeg(share);
    const h = { security_id, date: "2026-03-02", quantity: 20, cost_basis: 1000, price: 50 };
    const body = importBody(owner.account_id, [share, cash], {
      mappings: [{ investment: "Shared Fund", security_id, restated: false }],
      replace: [security_id],
      holdings: [h],
    });
    expect((await post(caller.client, body)).json).toEqual(success({ written: 2, alreadyImported: 0 }));
    expect(await storedRows("investment_transactions", { account_id: owner.account_id })).toEqual([
      storedTransaction(owner.user_id, share),
      storedTransaction(owner.user_id, cash),
    ]);
    expect(withoutStamps(await rowOf(stack, "holdings", `${owner.account_id}-${security_id}`))).toEqual(storedHolding(owner.user_id, owner.account_id, h));
    expect(await mappingsOf(owner.account_id)).toEqual({ "Shared Fund": { security_id, restated: false } });
    expect((await rowOf(stack, "snapshots", entered))?.is_deleted).toBe(true);

    // The owner sees them as already imported; a stranger cannot reach the account.
    expect((await post(owner.client, body)).json).toEqual(success({ written: 0, alreadyImported: 2 }));
    expect((await post(stranger.client, body)).json).toEqual(NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// The planned rows
// ---------------------------------------------------------------------------

describe("a planned row the account cannot take", () => {
  test("is refused with the row and what is wrong with it, and nothing is stored", async () => {
    const owner = await person("rows");
    const security_id = await cashSecurity(stack);
    const other = await account(owner.user_id, owner.item_id);
    const a = owner.account_id;
    const hex = "a".repeat(32);
    const record = { ex_date: "2026-03-02", cash_amount_per_share: 0.5, shares_held: 40 };
    const restatement = { investment: "Old Fund", units: 2, unit_price: 50 };
    /** A row and the message refusing it, which names the row. */
    const refusing = (leg: PlannedRow, problem: string): [PlannedRow, string] => [leg, `${idOf(leg)} ${problem}`];
    const cases: [PlannedRow, string][] = [
      // The id must be a plan statement row's.
      ...[
        "manual-123",
        `plan-${"A".repeat(32)}`,
        `plan-${"a".repeat(31)}`,
        `plan-${"a".repeat(33)}`,
        `plan-${hex}-cash-cash`,
        `plan-dividends-${hex}`,
        `plan-${hex}\n`,
        ` plan-${hex}`,
        `xplan-${hex}`,
      ].map((id) => refusing(shareLeg(a, security_id, { investment_transaction_id: id }), "is not a plan statement row id")),
      // And belong to this account.
      ...[other, a.toUpperCase(), undefined, null, 5].map((account_id) => refusing(shareLeg(a, security_id, { account_id }), "belongs to another account")),
      // A share movement buys or sells a statement kind's shares of a security.
      ...[
        { type: "cash" },
        { type: "BUY" },
        { type: null },
        { type: undefined },
        { subtype: "stock split" },
        { subtype: "dividend" },
        { subtype: "withdrawal" },
        { subtype: "transfer" },
        { subtype: undefined },
        { subtype: null },
        { subtype: 5 },
        { security_id: null },
        { security_id: undefined },
        { security_id: 5 },
      ].map((fields) => refusing(shareLeg(a, security_id, fields), "has the wrong type, subtype or security")),
      // A cash leg is cash of a statement kind, with no security.
      ...[
        { type: "buy" },
        { type: "sell" },
        { subtype: "dividend reinvestment" },
        { subtype: "sell" },
        { subtype: "buy" },
        { subtype: undefined },
        { security_id },
        { security_id: undefined },
        { security_id: "" },
      ].map((fields) => refusing(cashLeg(shareLeg(a, security_id), fields), "has the wrong type, subtype or security")),
      // Its figures are numbers, its name text.
      ...[{ amount: "1000" }, { quantity: null }, { price: undefined }, { amount: true }, { quantity: [20] }, { price: {} }].map((fields) =>
        refusing(shareLeg(a, security_id, fields), "has a figure that isn't a number"),
      ),
      ...[{ name: undefined }, { name: null }, { name: 5 }, { name: ["Buy"] }].map((fields) => refusing(shareLeg(a, security_id, fields), "has an unreadable name")),
      // The currency fits its column, counted in UTF-16 units.
      ...[5, true, {}, ["USD"], "DOLLARS-USD", "😀😀😀😀😀😀"].map((iso_currency_code) =>
        refusing(shareLeg(a, security_id, { iso_currency_code }), "has an unreadable currency"),
      ),
      // What a restated row was restated from.
      ...[
        {},
        { ...restatement, investment: 5 },
        { ...restatement, investment: undefined },
        { ...restatement, units: "2" },
        { ...restatement, unit_price: undefined },
        { ...restatement, unit_price: null },
      ].map((restated_from) => refusing(shareLeg(a, security_id, {}, { restated_from }), "has an unreadable restatement")),
      // What a reinvestment was inferred from: on a share movement, on its own date.
      ...[
        { ...record, ex_date: "2026-03-03" },
        { ...record, ex_date: "2026-02-30" },
        { ...record, ex_date: undefined },
        { ...record, shares_held: "40" },
        { ...record, cash_amount_per_share: undefined },
        { ...record, cash_amount_per_share: null },
        {},
        "2026-03-02",
        5,
        true,
        [],
      ].map((reinvested_distribution) =>
        refusing(shareLeg(a, security_id, { subtype: "dividend reinvestment" }, { reinvested_distribution }), "has an unreadable reinvestment"),
      ),
      refusing(cashLeg(shareLeg(a, security_id), {}, { reinvested_distribution: record }), "has an unreadable reinvestment"),
      // A restatement does not excuse an unreadable reinvestment.
      refusing(
        shareLeg(a, security_id, {}, { restated_from: restatement, reinvested_distribution: { ...record, ex_date: "2026-03-01" } }),
        "has an unreadable reinvestment",
      ),
    ];
    for (const [planned, message] of cases) {
      // A good row before it, and a security nobody has after it: the row is what is named.
      const body = importBody(a, [shareLeg(a, security_id), planned], { mappings: [{ investment: "F", security_id: "no-such-security", restated: false }] });
      expect([planned, (await post(owner.client, body)).json]).toEqual([planned, failed(message)]);
    }
    expect(await storedRows("investment_transactions", { user_id: owner.user_id })).toEqual([]);
    expect(await mappingsOf(a)).toBeNull();
  });

  test("is named first of several", async () => {
    const owner = await person("first");
    const security_id = await cashSecurity(stack);
    const first = shareLeg(owner.account_id, security_id, { name: null });
    const second = shareLeg(owner.account_id, security_id, { investment_transaction_id: "manual-2" });
    expect((await post(owner.client, importBody(owner.account_id, [first, second]))).json).toEqual(failed(`${idOf(first)} has an unreadable name`));
  });
});

describe("a planned row the account can take", () => {
  test("is stored with its checked fields alone, as a manual row, and the answer counts it", async () => {
    const owner = await person("store");
    const security_id = await cashSecurity(stack);
    // Whatever else the page sent is dropped: a label, an origin, a raw payload, an owner.
    const noise = { source: "plaid", label: { budget_id: "x-budget", memo: "x-memo" }, label_memo: "x-memo", raw: { x: 1 }, user_id: "x-user", is_deleted: true, fees: 1, updated: "x" };
    const share = shareLeg(owner.account_id, security_id, noise, { extra: "dropped" });
    const cash = cashLeg(share, noise);
    expect((await post(owner.client, importBody(owner.account_id, [share, cash]))).json).toEqual(success({ written: 2, alreadyImported: 0 }));
    expect(await storedRows("investment_transactions", { account_id: owner.account_id })).toEqual([
      storedTransaction(owner.user_id, share),
      storedTransaction(owner.user_id, cash),
    ]);
  });

  test("may be any kind's share movement or cash leg, or an inferred dividend", async () => {
    const owner = await person("kinds");
    const security_id = await cashSecurity(stack);
    const a = owner.account_id;
    const legs: PlannedRow[] = [];
    for (const [type, subtype, cashSubtype] of [
      ["buy", "contribution", "contribution"],
      ["buy", "dividend reinvestment", "dividend"],
      ["sell", "management fee", "management fee"],
      ["sell", "sell", "withdrawal"],
      ["buy", "buy", "transfer"],
      // A subtype goes with either share type: the figures give the direction, not the check.
      ["sell", "contribution", "contribution"],
      ["buy", "sell", "withdrawal"],
    ]) {
      const share = shareLeg(a, security_id, { type, subtype, name: `${type} ${subtype}` });
      legs.push(share, cashLeg(share, { subtype: cashSubtype, name: cashSubtype }));
    }
    const dividend = shareLeg(a, security_id, { investment_transaction_id: planId("plan-dividend-"), subtype: "dividend reinvestment" });
    legs.push(dividend, cashLeg(dividend, { subtype: "dividend" }));
    expect((await post(owner.client, importBody(a, legs))).json).toEqual(success({ written: legs.length, alreadyImported: 0 }));
    const stored = await storedRows("investment_transactions", { account_id: a });
    expect(stored).toHaveLength(legs.length);
    for (const leg of legs) expect(stored.find((row) => row?.investment_transaction_id === idOf(leg))).toEqual(storedTransaction(owner.user_id, leg));
  });

  test("keeps a currency of any short text or none, a name of any text, and the figures the columns hold", async () => {
    const owner = await person("figures");
    const security_id = await cashSecurity(stack);
    const a = owner.account_id;
    const kept = [
      shareLeg(a, security_id, { iso_currency_code: null }),
      shareLeg(a, security_id, { iso_currency_code: undefined }),
      shareLeg(a, security_id, { iso_currency_code: "" }),
      shareLeg(a, security_id, { iso_currency_code: "€€€€€€€€€€" }),
      shareLeg(a, security_id, { iso_currency_code: "😀😀😀😀😀" }),
      shareLeg(a, security_id, { name: "" }),
      shareLeg(a, security_id, { name: "Ünïcode ✓ 名前" }),
      shareLeg(a, security_id, { amount: -0.01, quantity: -999999999.999999, price: 999999999.999999 }),
      shareLeg(a, security_id, { amount: 9999999999999.99, quantity: 0, price: 0 }),
    ];
    // The columns round what they cannot hold to their scale.
    const rounded = shareLeg(a, security_id, { amount: 1.005, quantity: 0.0000005, price: 1e-7 });
    // The security id is a string; an empty one is stored as it is, and looked up nowhere.
    const noSecurity = shareLeg(a, "", { date: "2024-02-29" });
    const legs = [...kept, rounded, noSecurity];
    expect((await post(owner.client, importBody(a, legs))).json).toEqual(success({ written: legs.length, alreadyImported: 0 }));
    const stored = await storedRows("investment_transactions", { account_id: a });
    const byId = (leg: PlannedRow) => stored.find((row) => row?.investment_transaction_id === idOf(leg));
    for (const leg of kept) expect(byId(leg)).toEqual(storedTransaction(owner.user_id, leg));
    expect(byId(rounded)).toEqual({ ...storedTransaction(owner.user_id, rounded), amount: 1.01, quantity: 0.000001, price: 0 });
    expect(byId(noSecurity)).toEqual(storedTransaction(owner.user_id, noSecurity));
  });

  test("records what a restated row was restated from, or what a reinvestment was inferred from, and nothing else", async () => {
    const owner = await person("raw");
    const security_id = await cashSecurity(stack);
    const a = owner.account_id;
    const restated = shareLeg(a, security_id, {}, { restated_from: { investment: "Old Fund", units: 2.5, unit_price: 40, extra: 9 } });
    const reinvested = shareLeg(
      a,
      security_id,
      { subtype: "dividend reinvestment", name: "Buy (dividend reinvestment)" },
      { reinvested_distribution: { ex_date: "2026-03-02", cash_amount_per_share: 0.5, shares_held: 40, extra: 9 } },
    );
    // Both given: the restatement is what is kept.
    const both = shareLeg(
      a,
      security_id,
      {},
      { restated_from: { investment: "Both", units: 1, unit_price: 2 }, reinvested_distribution: { ex_date: "2026-03-02", cash_amount_per_share: 1, shares_held: 2 } },
    );
    // A falsy record is no record.
    const falsy = [0, "", false, null].map((reinvested_distribution) => shareLeg(a, security_id, {}, { reinvested_distribution }));
    // A cash leg may carry a restatement.
    const restatedCash = cashLeg(restated, {}, { restated_from: { investment: "Old Fund", units: 0, unit_price: 0 } });
    const all = [restated, reinvested, both, ...falsy, restatedCash];
    expect((await post(owner.client, importBody(a, all))).json).toEqual(success({ written: all.length, alreadyImported: 0 }));
    const stored = await storedRows("investment_transactions", { account_id: a });
    const rowOfLeg = (leg: PlannedRow) => stored.find((row) => row?.investment_transaction_id === idOf(leg));
    expect(rowOfLeg(restated)).toEqual(storedTransaction(owner.user_id, restated, { restated_from: { investment: "Old Fund", units: 2.5, unit_price: 40 } }));
    expect(rowOfLeg(reinvested)).toEqual(
      storedTransaction(owner.user_id, reinvested, { reinvested_distribution: { ex_date: "2026-03-02", cash_amount_per_share: 0.5, shares_held: 40 } }),
    );
    expect(rowOfLeg(both)?.raw).toEqual({ restated_from: { investment: "Both", units: 1, unit_price: 2 } });
    for (const leg of falsy) expect(rowOfLeg(leg)?.raw).toBeNull();
    expect(rowOfLeg(restatedCash)?.raw).toEqual({ restated_from: { investment: "Old Fund", units: 0, unit_price: 0 } });
  });

  test("planned twice is stored once, as the later one", async () => {
    const owner = await person("twice");
    const security_id = await cashSecurity(stack);
    const first = shareLeg(owner.account_id, security_id);
    const again = { transaction: { ...first.transaction, amount: 2000, quantity: 40, name: "Again" } };
    expect((await post(owner.client, importBody(owner.account_id, [first, again]))).json).toEqual(success({ written: 1, alreadyImported: 0 }));
    expect(await storedRows("investment_transactions", { account_id: owner.account_id })).toEqual([storedTransaction(owner.user_id, again)]);
  });

  test("already in the account is left as it is and counted apart", async () => {
    const owner = await person("again");
    const security_id = await cashSecurity(stack);
    const share = shareLeg(owner.account_id, security_id);
    const cash = cashLeg(share);
    await seedInvestmentTransaction(stack, owner.user_id, owner.account_id, { investment_transaction_id: idOf(share), security_id, amount: "1", name: "Edited by hand" });
    const before = await storedRows("investment_transactions", { investment_transaction_id: idOf(share) });
    expect((await post(owner.client, importBody(owner.account_id, [share, cash]))).json).toEqual(success({ written: 1, alreadyImported: 1 }));
    expect(await storedRows("investment_transactions", { investment_transaction_id: idOf(share) })).toEqual(before);
    expect(await storedRows("investment_transactions", { investment_transaction_id: idOf(cash) })).toEqual([storedTransaction(owner.user_id, cash)]);
    // The same rows again store nothing more, a row planned twice counted once.
    expect((await post(owner.client, importBody(owner.account_id, [share, cash, share]))).json).toEqual(success({ written: 0, alreadyImported: 2 }));
  });

  // Pins a Bun behaviour that looks like a bug, kept because Bun is the reference: a row whose id someone else's row holds is counted as written but not stored.
  // See "Pinned Bun behaviours" in conformance/README.md before changing it.
  test("whose id a row of someone else's holds is counted as written, and that row is left as it is", async () => {
    const [owner, stranger] = [await person("taken"), await person("taken-stranger")];
    const security_id = await cashSecurity(stack);
    const share = shareLeg(owner.account_id, security_id);
    await seedInvestmentTransaction(stack, stranger.user_id, stranger.account_id, { investment_transaction_id: idOf(share) });
    const before = await storedRows("investment_transactions", { investment_transaction_id: idOf(share) });
    expect((await post(owner.client, importBody(owner.account_id, [share]))).json).toEqual(success({ written: 1, alreadyImported: 0 }));
    expect(await storedRows("investment_transactions", { investment_transaction_id: idOf(share) })).toEqual(before);
    expect(await storedRows("investment_transactions", { account_id: owner.account_id })).toEqual([]);
  });

  test("goes in by the thousand, however long the statement", async () => {
    const owner = await person("long");
    const security_id = await cashSecurity(stack);
    const legs = Array.from({ length: 1001 }, () => shareLeg(owner.account_id, security_id, { name: "", iso_currency_code: null }));
    expect((await post(owner.client, importBody(owner.account_id, legs))).json).toEqual(success({ written: 1001, alreadyImported: 0 }));
    const [{ count }] = await stack.db.query<{ count: number }>("SELECT count(*)::int AS count FROM investment_transactions WHERE account_id = $1", [owner.account_id]);
    expect(count).toBe(1001);
    expect((await post(owner.client, importBody(owner.account_id, legs))).json).toEqual(success({ written: 0, alreadyImported: 1001 }));
  });
});

describe("a planned row someone deleted from the account", () => {
  test("stops the import before anything is stored, and comes back for the page to plan around", async () => {
    const owner = await person("deleted");
    const security_id = await cashSecurity(stack);
    const entered = await seedHoldingSnapshot(stack, owner.user_id, owner.account_id, security_id);
    const [first, second] = [shareLeg(owner.account_id, security_id), shareLeg(owner.account_id, security_id)];
    const [firstCash, secondCash, fresh] = [cashLeg(first), cashLeg(second), shareLeg(owner.account_id, security_id)];
    // One live row, and two deleted ones, stored in the order of their ids (the order they come back in).
    await seedInvestmentTransaction(stack, owner.user_id, owner.account_id, { investment_transaction_id: idOf(first) });
    for (const leg of [firstCash, secondCash]) {
      await seedInvestmentTransaction(stack, owner.user_id, owner.account_id, { investment_transaction_id: idOf(leg), type: "cash", subtype: "contribution", security_id: null });
      await softDeleteRow(stack, "investment_transactions", idOf(leg));
    }
    const before = await storedRows("investment_transactions", { account_id: owner.account_id });
    const body = importBody(owner.account_id, [first, firstCash, second, secondCash, fresh], {
      mappings: [{ investment: "Fund", security_id, restated: false }],
      replace: [security_id],
      holdings: [{ security_id, date: "2026-03-02", quantity: 1, cost_basis: null, price: 1 }],
    });
    expect((await post(owner.client, body)).json).toEqual(success({ written: 0, alreadyImported: 0, deleted: [idOf(firstCash), idOf(secondCash)] }));
    expect(await storedRows("investment_transactions", { account_id: owner.account_id })).toEqual(before);
    expect(await mappingsOf(owner.account_id)).toBeNull();
    expect(await rowOf(stack, "holdings", `${owner.account_id}-${security_id}`)).toBeUndefined();
    expect((await rowOf(stack, "snapshots", entered))?.is_deleted).toBe(false);
  });

  test("is looked for only once the securities are found", async () => {
    const owner = await person("deleted-later");
    const security_id = await cashSecurity(stack);
    const share = shareLeg(owner.account_id, security_id);
    await seedInvestmentTransaction(stack, owner.user_id, owner.account_id, { investment_transaction_id: idOf(share) });
    await softDeleteRow(stack, "investment_transactions", idOf(share));
    expect((await post(owner.client, importBody(owner.account_id, [share], { replace: ["no-such-security"] }))).json).toEqual(
      failed("Security no-such-security not found."),
    );
  });
});

// ---------------------------------------------------------------------------
// Securities
// ---------------------------------------------------------------------------

describe("the securities", () => {
  test("must all be stored; the first missing is named, rows first, then mappings, replaced positions and holdings", async () => {
    const owner = await person("secs");
    const known = await cashSecurity(stack);
    const a = owner.account_id;
    const holding = (security_id: string) => ({ security_id, date: "2026-03-02", quantity: 1, cost_basis: null, price: 1 });
    const mapping = (security_id: string) => ({ investment: `Fund ${security_id}`, security_id, restated: false });
    const cases: [Fields, string][] = [
      [importBody(a, [shareLeg(a, "missing-row")]), "missing-row"],
      [importBody(a, [shareLeg(a, known)], { mappings: [mapping(known), mapping("missing-mapping")] }), "missing-mapping"],
      [importBody(a, [], { replace: [known, "missing-replace"] }), "missing-replace"],
      [importBody(a, [], { holdings: [holding(known), holding("missing-holding")] }), "missing-holding"],
      [
        importBody(a, [shareLeg(a, known), shareLeg(a, "missing-row-2")], {
          mappings: [mapping("missing-mapping")],
          replace: ["missing-replace"],
          holdings: [holding("missing-holding")],
        }),
        "missing-row-2",
      ],
      [importBody(a, [], { mappings: [mapping("missing-mapping")], replace: ["missing-replace"], holdings: [holding("missing-holding")] }), "missing-mapping"],
      [importBody(a, [], { replace: ["missing-replace"], holdings: [holding("missing-holding")] }), "missing-replace"],
    ];
    for (const [body, missing] of cases) {
      expect([missing, (await post(owner.client, body)).json]).toEqual([missing, failed(`Security ${missing} not found.`)]);
    }
    expect(await storedRows("investment_transactions", { account_id: a })).toEqual([]);
    expect(await mappingsOf(a)).toBeNull();
    expect(await storedRows("holdings", { account_id: a })).toEqual([]);
  });
});
