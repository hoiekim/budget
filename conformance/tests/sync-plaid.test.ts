/**
 * The Plaid sync: what the scheduled sync (at every start, then hourly) does
 * with each Plaid item, and what a transactions sync stores, here triggered by
 * Plaid's `SYNC_UPDATES_AVAILABLE` webhook.
 *
 * The scheduled sync asks Plaid for an item's accounts and holdings, then its
 * transactions and investment transactions, stores them with their snapshots,
 * and records how the sync went on the item. A test seeds items, restarts the
 * server, and reads what the sync stored, logged and alarmed. Items are
 * retired after each test, so each start syncs only the test's own.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  PLAID_PRODUCTION_HOST,
  PLAID_SANDBOX_HOST,
  createUserClient,
  plaidAccount,
  plaidHolding,
  plaidInvestmentTransaction,
  plaidSecurity,
  plaidTransaction,
  startStack,
  type FakePlaidItem,
  type Stack,
} from "../harness";
import type { Row } from "../harness/postgres";
import {
  rowOf,
  rowsOf,
  seedAccount,
  seedHolding,
  seedInvestmentTransaction,
  seedItem,
  seedSecurity,
  seedSplitTransaction,
  seedTransaction,
  seedTransactionPair,
} from "../harness/seed/accounts";
import { withWritesBroken } from "../harness/seed/snapshots";
import { seedCategoryTree, seedRejection, storedRejections } from "../harness/seed/transactions";

// Every test restarts the server at least once: give each the suite's 30 seconds.
setDefaultTimeout(30_000);

let stack: Stack;
let adminId: string;
let kid: string;
beforeAll(async () => {
  stack = await startStack();
  adminId = await stack.userId("admin");
  ({ kid } = stack.upstream.plaid.addWebhookKey("sync-plaid-key"));
  // The cash security every inferred cash holding is of, with an id the comparison can read.
  await seedSecurity(stack, "sync-usd-cash", { ticker_symbol: "USD", name: "US Dollar Cash", type: "cash", close_price: "1" });
});
afterAll(() => stack.stop());

// Each start syncs every stored item and prices every held security: retire this test's.
afterEach(async () => {
  await stack.db.query("UPDATE items SET is_deleted = TRUE");
  await stack.db.query("UPDATE holdings SET is_deleted = TRUE");
});

const pad = (n: number) => String(n).padStart(2, "0");
/** `YYYY-MM-DD` of the local day `days` from today, as the servers compute it. */
const localDay = (days = 0): string => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const squashed = (day: string) => day.replace(/-/g, "");
const twoYearsBack = (): string => {
  const date = new Date();
  date.setFullYear(new Date().getFullYear() - 2);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** A Plaid item stored for `user_id` (with `row` set) that the fake knows by the same access token. */
const plaidItem = async (user_id: string, item_id: string, row: Row = {}, plaid: Partial<FakePlaidItem> = {}) => {
  const access_token = plaid.access_token ?? `access-production-${item_id}`;
  await seedItem(stack, user_id, "plaid", { item_id, access_token, available_products: ["transactions", "investments"], ...row });
  stack.upstream.plaid.addItem({ item_id, access_token, products: ["transactions", "investments"], ...plaid });
  return { item_id, access_token };
};

/** The Plaid calls made from `from` on, as `[host, path, body]`. */
const callsSince = (from: number) => stack.upstream.plaid.seen().slice(from).map((r) => [r.host, r.path, r.json]);

/**
 * Runs `run` as an `unordered` window. The Bun server asks for an item's
 * accounts and holdings at once, then for its transactions and investment
 * transactions at once, and each pair reaches Plaid in either order (a new
 * connection through the proxy can lose to one opened a moment later), so
 * these calls are compared as a set; the tests assert the order that is fixed.
 */
const unordered = <T>(run: () => Promise<T>): Promise<T> => stack.upstream.hub.unordered(run);

const byJson = (a: unknown, b: unknown) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);

/** Expects `calls` to be the `phases` one after another, the calls of each phase in any order. */
const expectPhases = (calls: unknown[][], phases: unknown[][][]) => {
  let at = 0;
  for (const phase of phases) {
    expect([...calls.slice(at, at + phase.length)].sort(byJson)).toEqual([...phase].sort(byJson));
    at += phase.length;
  }
  expect(calls).toHaveLength(at);
};

/** The logged context of the latest line containing `message`. */
const logged = (message: string): Record<string, unknown> => {
  const line = [...stack.logs].reverse().find((l) => l.includes(message));
  if (!line) throw new Error(`no "${message}" line in the log`);
  return JSON.parse(line.slice(line.indexOf("{")));
};

const alarmsTitled = (title: string) => stack.upstream.discord.alarms().filter((alarm) => alarm.title === `🚨 Budget Server Error: ${title}`);

/** Posts Plaid's `SYNC_UPDATES_AVAILABLE` webhook for the item, signed. */
const syncViaWebhook = async (item_id: string) => {
  const text = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id });
  const result = await stack.anonymous().request("POST", "/plaid-hook", {
    rawBody: text,
    headers: { "Content-Type": "application/json", "Plaid-Verification": stack.upstream.plaid.signWebhook(text, { kid }) },
  });
  expect(result.json).toEqual({ status: "success" });
  return logged("Synced transactions via webhook");
};

describe("the scheduled sync of a Plaid item", () => {
  test("stores its accounts, holdings, securities and both kinds of transactions, and records the sync", async () => {
    const checking = "sync-full-checking";
    const brokerage = "sync-full-brokerage";
    const security_id = "sync-full-sec";
    const { item_id, access_token } = await plaidItem(
      adminId,
      "sync-full",
      { institution_id: "ins_sync", updated: null },
      {
        accounts: [
          plaidAccount({ account_id: checking, name: "Full Checking", mask: "1111" }),
          plaidAccount({
            account_id: brokerage,
            name: "Full Brokerage",
            type: "investment",
            subtype: "brokerage",
            balances: { available: null, current: 2500, iso_currency_code: "USD", limit: null, unofficial_currency_code: null },
          }),
        ],
        holdings: [plaidHolding({ account_id: brokerage, security_id, quantity: 10, institution_price: 150, institution_value: 1500, cost_basis: 1200 })],
        securities: [plaidSecurity({ security_id, ticker_symbol: "SFULL", name: "Full Fund", close_price: 150, close_price_as_of: "2026-03-01" })],
        investmentTransactions: [plaidInvestmentTransaction({ investment_transaction_id: "sync-full-inv", account_id: brokerage, security_id, date: localDay(-1) })],
      },
    );
    stack.upstream.plaid.addSyncPage(access_token, {
      added: [plaidTransaction({ transaction_id: "sync-full-tx-1", account_id: checking, date: localDay(-3), authorized_date: localDay(-4) })],
    });
    stack.upstream.plaid.addSyncPage(access_token, {
      added: [plaidTransaction({ transaction_id: "sync-full-tx-2", account_id: checking, date: localDay(-2), authorized_date: null, pending: true })],
    });
    const from = stack.upstream.plaid.seen().length;
    await unordered(() => stack.restart());

    // The accounts and holdings, then the transactions pages and the investment transactions,
    // each transactions page after the one before has answered.
    const calls = callsSince(from);
    expectPhases(calls, [
      [
        [PLAID_PRODUCTION_HOST, "/accounts/get", { access_token }],
        [PLAID_PRODUCTION_HOST, "/investments/holdings/get", { access_token }],
      ],
      [
        [PLAID_PRODUCTION_HOST, "/transactions/sync", { access_token }],
        [
          PLAID_PRODUCTION_HOST,
          "/investments/transactions/get",
          { access_token, start_date: twoYearsBack(), end_date: localDay(), options: { count: 100, offset: 0 } },
        ],
        [PLAID_PRODUCTION_HOST, "/transactions/sync", { access_token, cursor: "cursor-1" }],
      ],
    ]);
    expect(calls.filter(([, path]) => path === "/transactions/sync").map(([, , body]) => body)).toEqual([
      { access_token },
      { access_token, cursor: "cursor-1" },
    ]);
    expect(logged("Synced Plaid item")).toEqual({ itemId: item_id, accountsUpdated: 4, transactionsUpdated: 3 });

    const accounts = await rowsOf(stack, "accounts", { item_id });
    expect(accounts.map((a) => [a.account_id, a.name, a.type, a.subtype, a.institution_id, a.hide, a.custom_name, a.balances_current])).toEqual([
      [brokerage, "Full Brokerage", "investment", "brokerage", "ins_sync", false, "", 2500],
      [checking, "Full Checking", "depository", "checking", "ins_sync", false, "", 110],
    ]);
    expect(accounts[1]).toMatchObject({
      user_id: adminId,
      label_budget_id: null,
      graph_options_use_snapshots: true,
      graph_options_use_holding_snapshots: true,
      graph_options_use_transactions: true,
      is_deleted: false,
    });
    // A balance snapshot for each new account, dated today.
    expect((await rowsOf(stack, "snapshots", { account_id: checking })).map((s) => [s.snapshot_id, s.snapshot_type, s.balances_current])).toEqual([
      [`${checking}-${squashed(localDay())}`, "account_balance", 110],
    ]);

    // The reported holding, and the cash Plaid didn't report: the balance the holdings don't account for.
    const holdings = await rowsOf(stack, "holdings", { account_id: brokerage });
    expect(holdings.map((h) => [h.holding_id, h.security_id, h.quantity, h.institution_value])).toEqual([
      [`${brokerage}-sync-usd-cash`, "sync-usd-cash", 1000, 1000],
      [`${brokerage}_${security_id}`, security_id, 10, 1500],
    ]);
    expect(await rowOf(stack, "securities", security_id)).toMatchObject({ ticker_symbol: "SFULL", name: "Full Fund", close_price: 150 });
    // The security's price is filed under the day Plaid says it is for.
    expect(await rowOf(stack, "snapshots", `${security_id}-20260301`)).toMatchObject({
      snapshot_type: "security",
      security_id,
      close_price: 150,
    });

    // A transaction is filed under the day it was authorized, or posted when Plaid gives no authorization day.
    expect(await rowOf(stack, "transactions", "sync-full-tx-1")).toMatchObject({
      account_id: checking,
      user_id: adminId,
      date: localDay(-4),
      pending: false,
      is_deleted: false,
      raw: expect.objectContaining({ date: `${localDay(-3)}T00:00:00`, authorized_date: `${localDay(-4)}T00:00:00` }),
    });
    expect(await rowOf(stack, "transactions", "sync-full-tx-2")).toMatchObject({ date: localDay(-2), pending: true });
    expect(await rowOf(stack, "investment_transactions", "sync-full-inv")).toMatchObject({ account_id: brokerage, date: localDay(-1), is_deleted: false });

    expect(await rowOf(stack, "items", item_id)).toMatchObject({
      cursor: "cursor-2",
      status: "ok",
      last_sync_status: "success",
      last_sync_at: expect.any(String),
      last_sync_error: null,
    });
  });

  test("keeps what the user set on accounts, snapshots only changed balances, and retires the holdings Plaid no longer reports", async () => {
    const checking = "sync-again-checking";
    const brokerage = "sync-again-brokerage";
    const { item_id } = await plaidItem(
      adminId,
      "sync-again",
      { institution_id: null },
      {
        products: ["investments"],
        accounts: [
          plaidAccount({ account_id: checking, name: "Again Checking", balances: { available: 100.5, current: 110.25, iso_currency_code: "USD", limit: null, unofficial_currency_code: null } }),
          plaidAccount({
            account_id: brokerage,
            name: "Again Brokerage",
            type: "investment",
            subtype: "ira",
            balances: { available: null, current: 900, iso_currency_code: "USD", limit: null, unofficial_currency_code: null },
          }),
          plaidAccount({ account_id: "sync-again-new", name: "Again New" }),
        ],
        holdings: [plaidHolding({ account_id: brokerage, security_id: "sync-again-kept", quantity: 3, institution_price: 300, institution_value: 900 })],
        securities: [plaidSecurity({ security_id: "sync-again-kept", ticker_symbol: "KEPT", close_price: 300, close_price_as_of: "2026-03-02" })],
      },
    );
    const { budget_id } = await seedCategoryTree(stack, adminId);
    await seedAccount(stack, adminId, item_id, {
      account_id: checking,
      custom_name: "My Checking",
      hide: true,
      label_budget_id: budget_id,
      graph_options_use_snapshots: false,
      graph_options_use_transactions: false,
      balances_available: "100.5",
      balances_current: "110.25",
      balances_limit: null,
    });
    await seedAccount(stack, adminId, item_id, { account_id: brokerage, type: "investment", subtype: "ira", balances_current: "800" });
    await seedSecurity(stack, "sync-again-sold", { ticker_symbol: "SOLD" });
    await seedHolding(stack, adminId, brokerage, "sync-again-sold", { holding_id: `${brokerage}_sync-again-sold` });
    await unordered(() => stack.restart());

    expect(logged("Synced Plaid item")).toEqual({ itemId: item_id, accountsUpdated: 6, transactionsUpdated: 0 });
    // An item without an institution files its accounts under "unknown".
    expect(await rowOf(stack, "accounts", checking)).toMatchObject({
      institution_id: "unknown",
      custom_name: "My Checking",
      hide: true,
      label_budget_id: budget_id,
      graph_options_use_snapshots: false,
      graph_options_use_holding_snapshots: true,
      graph_options_use_transactions: false,
      name: "Again Checking",
    });
    expect(await rowOf(stack, "accounts", "sync-again-new")).toMatchObject({ institution_id: "unknown", custom_name: "", hide: false });
    // The checking balances didn't change: no snapshot. The brokerage's did, and the new account is new.
    const snapshotIds = (await rowsOf(stack, "snapshots", { snapshot_type: "account_balance" }))
      .map((s) => s.snapshot_id)
      .filter((id) => String(id).startsWith("sync-again"));
    expect(snapshotIds).toEqual([`${brokerage}-${squashed(localDay())}`, `sync-again-new-${squashed(localDay())}`]);

    // The holding Plaid no longer reports gets a zero snapshot and is deleted.
    expect(await rowOf(stack, "holdings", `${brokerage}_sync-again-sold`)).toMatchObject({ is_deleted: true });
    expect(await rowOf(stack, "snapshots", `${brokerage}_sync-again-sold-${squashed(localDay())}`)).toMatchObject({
      snapshot_type: "holding",
      holding_account_id: brokerage,
      quantity: 0,
      institution_value: 0,
    });
    expect(await rowOf(stack, "holdings", `${brokerage}_sync-again-kept`)).toMatchObject({ quantity: 3, is_deleted: false });
    // Fully invested: no cash is inferred.
    expect(await rowOf(stack, "holdings", `${brokerage}-sync-usd-cash`)).toBeUndefined();
  });

  test("warns and alarms when Plaid re-issues the id of an account it already has", async () => {
    const { item_id } = await plaidItem(
      adminId,
      "sync-churn",
      { available_products: ["transactions"] },
      {
        accounts: [
          // Same name (whatever the case), no mask and the same subtype as a stored account: re-issued.
          plaidAccount({ account_id: "sync-churn-new", name: "everyday checking", mask: null, subtype: "checking" }),
          // Stored accounts keep no mask, so an account with one is never matched.
          plaidAccount({ account_id: "sync-churn-masked", name: "Everyday Checking", mask: "1234", subtype: "checking" }),
          plaidAccount({ account_id: "sync-churn-savings", name: "Everyday Checking", mask: null, subtype: "savings" }),
        ],
      },
    );
    await seedAccount(stack, adminId, item_id, { account_id: "sync-churn-old", name: "Everyday Checking", subtype: "checking" });
    await seedAccount(stack, adminId, item_id, { account_id: "sync-churn-archived", name: "Everyday Checking", subtype: "checking", archived: true });
    await stack.restart();

    expect(stack.logCount("Provider re-issued account_id for an existing account")).toBe(1);
    expect(logged("Provider re-issued account_id for an existing account")).toEqual({
      itemId: item_id,
      oldAccountId: "sync-churn-old",
      newAccountId: "sync-churn-new",
      name: "everyday checking",
      mask: null,
      subtype: "checking",
    });
    await stack.waitFor(() => alarmsTitled("Account ID churn detected").length === 1, { what: "the churn alarm" });
    expect(alarmsTitled("Account ID churn detected")[0].description).toBe(
      `**Item:** ${item_id}\n**Old account_id:** sync-churn-old\n**New account_id:** sync-churn-new\n**Name:** everyday checking\n**Mask:** null\n**Subtype:** checking`,
    );
    // The new id is stored like any account: the next sync knows it and says nothing.
    expect(await rowOf(stack, "accounts", "sync-churn-new")).toMatchObject({ item_id, is_deleted: false });
    await stack.restart();
    expect(stack.logCount("Provider re-issued account_id for an existing account")).toBe(1);
  });

  test("syncs every item, the demo user's in the sandbox, and an item of another provider or none is left alone", async () => {
    const demoId = await stack.userId("demo");
    const sandbox = await plaidItem(
      demoId,
      "sync-demo",
      { access_token: "access-sandbox-sync-demo", available_products: ["transactions"] },
      { access_token: "access-sandbox-sync-demo", host: PLAID_SANDBOX_HOST, accounts: [plaidAccount({ account_id: "sync-demo-account" })] },
    );
    const production = await plaidItem(adminId, "sync-production", { available_products: ["transactions"] }, { accounts: [] });
    await seedItem(stack, adminId, "manual", { item_id: "sync-manual" });
    const from = stack.upstream.plaid.seen().length;
    await stack.restart();
    const calls = callsSince(from);
    expect(calls.filter(([host]) => host === PLAID_SANDBOX_HOST)).toEqual([
      [PLAID_SANDBOX_HOST, "/accounts/get", { access_token: sandbox.access_token }],
      [PLAID_SANDBOX_HOST, "/transactions/sync", { access_token: sandbox.access_token }],
    ]);
    expect(calls.filter(([host]) => host === PLAID_PRODUCTION_HOST)).toEqual([
      [PLAID_PRODUCTION_HOST, "/accounts/get", { access_token: production.access_token }],
      [PLAID_PRODUCTION_HOST, "/transactions/sync", { access_token: production.access_token }],
    ]);
    expect(await rowOf(stack, "accounts", "sync-demo-account")).toMatchObject({ user_id: demoId, item_id: "sync-demo" });
    expect(await rowOf(stack, "items", "sync-manual")).toMatchObject({ last_sync_status: null, last_sync_at: null });
    expect(await rowOf(stack, "items", "sync-production")).toMatchObject({ last_sync_status: "success" });
  });
});

describe("Plaid's errors during the scheduled sync", () => {
  // Pins a Bun behaviour that looks like a bug, kept because Bun is the reference: an item that needs its user to log in again is marked bad, yet the sync is recorded as a success.
  // See "Pinned Bun behaviours" in conformance/README.md before changing it.
  test("an item that needs its user to log in again is marked bad, and the sync still counts as done", async () => {
    const { item_id, access_token } = await plaidItem(
      adminId,
      "sync-login",
      {},
      { accounts: [plaidAccount({ account_id: "sync-login-brokerage", type: "investment", subtype: "brokerage" })] },
    );
    for (const endpoint of ["/accounts/get", "/investments/holdings/get", "/transactions/sync", "/investments/transactions/get"]) {
      stack.upstream.plaid.fail(endpoint, { error_code: "ITEM_LOGIN_REQUIRED" }, { accessToken: access_token });
    }
    const from = stack.upstream.plaid.seen().length;
    await unordered(() => stack.restart());
    expectPhases(
      callsSince(from).map(([, path]) => [path]),
      [
        [["/accounts/get"], ["/investments/holdings/get"]],
        [["/transactions/sync"], ["/investments/transactions/get"]],
      ],
    );
    expect(stack.logCount(`Failed to get accounts data: ITEM_LOGIN_REQUIRED {"itemId":"${item_id}"}`)).toBe(1);
    expect(stack.logCount(`Failed to get transactions data: ITEM_LOGIN_REQUIRED {"itemId":"${item_id}"}`)).toBe(1);
    expect(stack.logs.some((line) => line.includes(`Failed to get holdings data {"itemId":"${item_id}"}`))).toBe(true);
    expect(stack.logs.some((line) => line.includes(`Failed to get investment transaction data {"itemId":"${item_id}"}`))).toBe(true);
    expect(logged("Synced Plaid item")).toEqual({ itemId: item_id, accountsUpdated: 0, transactionsUpdated: 0 });
    await stack.waitFor(async () => (await rowOf(stack, "items", item_id))?.status === "bad", { what: "the item marked bad" });
    expect(await rowOf(stack, "items", item_id)).toMatchObject({
      status: "bad",
      status_reason: "ITEM_LOGIN_REQUIRED",
      last_sync_status: "success",
      last_sync_error: null,
      cursor: null,
    });
    expect(await rowsOf(stack, "accounts", { item_id })).toEqual([]);
  });

  test("an error that is not the item's is logged and leaves the item as it was", async () => {
    const { item_id, access_token } = await plaidItem(adminId, "sync-api-error", { available_products: ["transactions"] }, { accounts: [plaidAccount()] });
    stack.upstream.plaid.fail("/accounts/get", { error_code: "INTERNAL_SERVER_ERROR" }, { accessToken: access_token });
    stack.upstream.plaid.fail("/transactions/sync", { error_code: "RATE_LIMIT_EXCEEDED" }, { accessToken: access_token });
    await stack.restart();
    expect(stack.logs.some((line) => line.includes(`Failed to get accounts data {"itemId":"${item_id}"}`))).toBe(true);
    expect(stack.logs.some((line) => line.includes(`Failed to get transactions data {"itemId":"${item_id}"}`))).toBe(true);
    expect(await rowOf(stack, "items", item_id)).toMatchObject({ status: "ok", status_reason: null, last_sync_status: "success" });
  });

  test("an item without investment accounts is not an error; one whose investments Plaid doesn't support loses the product", async () => {
    // No investment account: Plaid answers NO_INVESTMENT_ACCOUNTS, which the sync ignores.
    const quiet = await plaidItem(adminId, "sync-no-investments", { available_products: ["investments"] }, { accounts: [plaidAccount()] });
    await unordered(() => stack.restart());
    expect(stack.logs.some((line) => line.includes("Failed to get holdings data") && line.includes(quiet.item_id))).toBe(false);
    expect(await rowOf(stack, "items", quiet.item_id)).toMatchObject({ status: "ok", available_products: ["investments"] });
    await stack.db.query("UPDATE items SET is_deleted = TRUE");

    // Investment transactions Plaid doesn't support: the item drops the product.
    const { item_id, access_token } = await plaidItem(
      adminId,
      "sync-unsupported",
      { available_products: ["transactions", "investments"] },
      { accounts: [plaidAccount({ account_id: "sync-unsupported-brokerage", type: "investment", subtype: "brokerage" })] },
    );
    stack.upstream.plaid.fail("/investments/transactions/get", { error_code: "PRODUCTS_NOT_SUPPORTED" }, { accessToken: access_token });
    await unordered(() => stack.restart());
    await stack.waitFor(async () => !((await rowOf(stack, "items", item_id))?.available_products as string[]).includes("investments"), {
      what: "the product dropped",
    });
    expect(await rowOf(stack, "items", item_id)).toMatchObject({ available_products: ["transactions"], status: "ok" });
    expect(stack.logCount(`Investment transactions not supported for item, removing Investments from available_products {"itemId":"${item_id}"}`)).toBe(1);
  });
});

describe("a scheduled sync that fails", () => {
  test("for an item's accounts is logged, alarmed and recorded on the item, and its transactions are not synced", async () => {
    // An item whose products were never stored: reading them fails once the accounts are asked for.
    const { item_id, access_token } = await plaidItem(adminId, "sync-no-products", { available_products: null }, { accounts: [plaidAccount({ account_id: "sync-no-products-account" })] });
    const from = stack.upstream.plaid.seen().length;
    await stack.restart();
    const message = "null is not an object (evaluating 'item.available_products.includes')";
    expect(callsSince(from)).toEqual([[PLAID_PRODUCTION_HOST, "/accounts/get", { access_token }]]);
    expect(stack.logCount(`Sync Plaid accounts failed {"itemId":"${item_id}"}`)).toBe(1);
    expect(logged("Synced Plaid item")).toEqual({ itemId: item_id, accountsUpdated: 0, transactionsUpdated: 0, syncError: message });
    await stack.waitFor(() => alarmsTitled("Scheduled Sync Error: Plaid accounts failed").length === 1, { what: "the alarm" });
    expect(alarmsTitled("Scheduled Sync Error: Plaid accounts failed")[0].description).toBe(`**Item:** ${item_id}\n**Error:** ${message}`);
    expect(await rowOf(stack, "items", item_id)).toMatchObject({ last_sync_status: "failed", last_sync_error: message });
    // The accounts that were asked for are stored all the same.
    await stack.waitFor(async () => (await rowOf(stack, "accounts", "sync-no-products-account")) !== undefined, { what: "the account" });
  });

  test("to store an item's accounts is logged as such, alarmed and recorded on the item", async () => {
    // An account without a name can't be compared with the item's stored accounts.
    const { item_id } = await plaidItem(
      adminId,
      "sync-nameless",
      { available_products: ["transactions"] },
      { accounts: [plaidAccount({ account_id: "sync-nameless-new", name: null })] },
    );
    await seedAccount(stack, adminId, item_id, { account_id: "sync-nameless-old" });
    const alarms = alarmsTitled("Scheduled Sync Error: Plaid accounts failed").length;
    await stack.restart();
    const message = "null is not an object (evaluating 'account.name.toLowerCase')";
    expect(stack.logCount(`Sync accounts failed {"itemId":"${item_id}"}`)).toBe(1);
    expect(stack.logCount(`Sync Plaid accounts failed {"itemId":"${item_id}"}`)).toBe(1);
    await stack.waitFor(() => alarmsTitled("Scheduled Sync Error: Plaid accounts failed").length === alarms + 1, { what: "the alarm" });
    expect(alarmsTitled("Scheduled Sync Error: Plaid accounts failed").at(-1)?.description).toBe(`**Item:** ${item_id}\n**Error:** ${message}`);
    expect(await rowOf(stack, "items", item_id)).toMatchObject({ last_sync_status: "failed", last_sync_error: message });
    expect(await rowOf(stack, "accounts", "sync-nameless-new")).toBeUndefined();
  });

  test("to store an item's holdings is logged as such, alarmed and recorded on the item", async () => {
    const brokerage = "sync-holdings-fail-brokerage";
    const { item_id } = await plaidItem(
      adminId,
      "sync-holdings-fail",
      {},
      {
        accounts: [plaidAccount({ account_id: brokerage, type: "investment", subtype: "brokerage" })],
        holdings: [plaidHolding({ account_id: brokerage, security_id: "sync-holdings-fail-kept" })],
        securities: [plaidSecurity({ security_id: "sync-holdings-fail-kept", ticker_symbol: "HKEPT" })],
      },
    );
    await seedAccount(stack, adminId, item_id, { account_id: brokerage, type: "investment" });
    await seedSecurity(stack, "sync-holdings-fail-sold", { ticker_symbol: "HSOLD" });
    const sold = await seedHolding(stack, adminId, brokerage, "sync-holdings-fail-sold");
    const alarms = alarmsTitled("Scheduled Sync Error: Plaid accounts failed").length;
    const from = stack.upstream.plaid.seen().length;
    // Deleting the holding Plaid no longer reports fails.
    await withWritesBroken(stack, "holdings", { event: "UPDATE", when: "NEW.is_deleted = TRUE", mode: "raise" }, () =>
      unordered(() => stack.restart()),
    );
    const message = "conformance: refused";
    expectPhases(
      callsSince(from).map(([, path]) => [path]),
      [[["/accounts/get"], ["/investments/holdings/get"]]],
    );
    expect(stack.logCount(`Sync holdings failed {"itemId":"${item_id}"}`)).toBe(1);
    expect(stack.logCount(`Sync Plaid accounts failed {"itemId":"${item_id}"}`)).toBe(1);
    await stack.waitFor(() => alarmsTitled("Scheduled Sync Error: Plaid accounts failed").length === alarms + 1, { what: "the alarm" });
    expect(alarmsTitled("Scheduled Sync Error: Plaid accounts failed").at(-1)?.description).toBe(`**Item:** ${item_id}\n**Error:** ${message}`);
    expect(await rowOf(stack, "items", item_id)).toMatchObject({ last_sync_status: "failed", last_sync_error: message });
    // The zero snapshot was written before the delete failed; the holding itself stays.
    expect(await rowOf(stack, "holdings", sold)).toMatchObject({ is_deleted: false });
    expect(await rowOf(stack, "snapshots", `${sold}-${squashed(localDay())}`)).toMatchObject({ quantity: 0 });
  });

  test("for an item's transactions is logged, alarmed and recorded on the item", async () => {
    const { item_id, access_token } = await plaidItem(adminId, "sync-bad-date", { available_products: ["transactions"] }, { accounts: [] });
    // A date that is not text can't be read.
    stack.upstream.plaid.addSyncPage(access_token, { added: [plaidTransaction({ transaction_id: "sync-bad-date-tx", date: 20260302 })] });
    await stack.restart();
    const message = `dateString.includes is not a function. (In 'dateString.includes("T")', 'dateString.includes' is undefined)`;
    expect(stack.logCount(`Sync Plaid transactions failed {"itemId":"${item_id}"}`)).toBe(1);
    expect(logged("Synced Plaid item")).toEqual({ itemId: item_id, accountsUpdated: 0, transactionsUpdated: 0, syncError: message });
    await stack.waitFor(() => alarmsTitled("Scheduled Sync Error: Plaid transactions failed").length === 1, { what: "the alarm" });
    expect(alarmsTitled("Scheduled Sync Error: Plaid transactions failed")[0].description).toBe(`**Item:** ${item_id}\n**Error:** ${message}`);
    expect(await rowOf(stack, "items", item_id)).toMatchObject({ last_sync_status: "failed", last_sync_error: message, cursor: null });
    expect(await rowOf(stack, "transactions", "sync-bad-date-tx")).toBeUndefined();
  });

  test("to read the items is logged and alarmed, and the sync still completes", async () => {
    const { item_id } = await plaidItem(adminId, "sync-unreadable");
    await stack.db.query(`UPDATE items SET raw = '"not an object"'::jsonb WHERE item_id = $1`, [item_id]);
    const from = stack.upstream.plaid.seen().length;
    const failures = stack.logCount("Error occurred during scheduled sync");
    await stack.restart();
    expect(stack.logCount("Error occurred during scheduled sync")).toBe(failures + 1);
    expect(stack.upstream.plaid.seen()).toHaveLength(from);
    await stack.waitFor(() => alarmsTitled("Scheduled Sync Failed").length === 1, { what: "the alarm" });
    expect(alarmsTitled("Scheduled Sync Failed")[0].description).toMatch(/^\*\*Error:\*\* /);
  });

  test("on a server without Plaid credentials, Plaid items are skipped and logged as such", async () => {
    const unconfigured = await startStack({ env: { PLAID_SECRET_PRODUCTION: undefined, PLAID_SECRET_DEVELOPMENT: undefined } });
    try {
      await seedItem(unconfigured, await unconfigured.userId("admin"), "plaid", { item_id: "unconfigured-item" });
      await unconfigured.restart();
      expect(unconfigured.logCount("Plaid is not configured — skipping Plaid sync for all items")).toBe(2);
      expect(unconfigured.logCount("Synced Plaid item")).toBe(0);
      expect(unconfigured.upstream.plaid.seen()).toEqual([]);
      expect(await rowOf(unconfigured, "items", "unconfigured-item")).toMatchObject({ last_sync_status: null });
    } finally {
      await unconfigured.stop();
    }
  });
});

describe("a transactions sync", () => {
  test("carries a pending transaction's label, splits and rejected categories to the posted one that replaces it", async () => {
    const account_id = "sync-pp-account";
    const { item_id, access_token } = await plaidItem(adminId, "sync-pp", { available_products: ["transactions"] });
    await seedAccount(stack, adminId, item_id, { account_id });
    const { budget_id, section_id, category_id } = await seedCategoryTree(stack, adminId);
    const { category_id: rejected } = await stack.db.insert<{ category_id: string }>("categories", {
      user_id: adminId,
      section_id,
      name: "Rejected category",
      capacities: [],
    });
    await seedTransaction(stack, adminId, account_id, {
      transaction_id: "sync-pp-pending",
      date: localDay(-2),
      pending: true,
      label_budget_id: budget_id,
      label_category_id: category_id,
      label_memo: "lunch with the team",
    });
    const split = await seedSplitTransaction(stack, adminId, "sync-pp-pending", account_id, { custom_name: "my half", date: localDay(-2) });
    await seedRejection(stack, adminId, "sync-pp-pending", rejected);
    const other = await seedTransaction(stack, adminId, account_id, { transaction_id: "sync-pp-other", date: localDay(-2) });
    const pair = await seedTransactionPair(stack, adminId, "sync-pp-pending", other);

    stack.upstream.plaid.addSyncPage(access_token, {
      added: [
        plaidTransaction({
          transaction_id: "sync-pp-posted",
          pending_transaction_id: "sync-pp-pending",
          account_id,
          date: localDay(-1),
          authorized_date: localDay(-2),
        }),
      ],
      removed: [{ account_id, transaction_id: "sync-pp-pending" }],
    });
    expect(await syncViaWebhook(item_id)).toEqual({ itemId: item_id, added: 1, modified: 0, removed: 1 });

    expect(await rowOf(stack, "transactions", "sync-pp-posted")).toMatchObject({
      date: localDay(-2),
      pending_transaction_id: "sync-pp-pending",
      label_budget_id: budget_id,
      label_category_id: category_id,
      label_memo: "lunch with the team",
      is_deleted: false,
    });
    expect(await rowOf(stack, "transactions", "sync-pp-pending")).toMatchObject({ is_deleted: true });
    expect(await rowOf(stack, "split_transactions", split)).toMatchObject({ transaction_id: "sync-pp-posted", custom_name: "my half", is_deleted: false });
    expect(await storedRejections(stack, "sync-pp-posted")).toEqual([[adminId, rejected]]);
    expect(await storedRejections(stack, "sync-pp-pending")).toEqual([]);
    expect(await rowOf(stack, "transaction_pairs", pair)).toMatchObject({ is_deleted: true });
  });

  test("keeps the labels of changed rows, follows a re-served pending id, and deletes removed rows with their splits", async () => {
    const account_id = "sync-mod-account";
    const { item_id, access_token } = await plaidItem(adminId, "sync-mod", { available_products: ["transactions"] });
    await seedAccount(stack, adminId, item_id, { account_id });
    await seedTransaction(stack, adminId, account_id, { transaction_id: "sync-mod-kept", date: localDay(-3), amount: "10", label_memo: "mine" });
    await seedTransaction(stack, adminId, account_id, {
      transaction_id: "sync-mod-posted",
      pending_transaction_id: "sync-mod-pending",
      date: localDay(-3),
      label_memo: "from the posted row",
    });
    await seedTransaction(stack, adminId, account_id, { transaction_id: "sync-mod-gone", date: localDay(-3) });
    const goneSplit = await seedSplitTransaction(stack, adminId, "sync-mod-gone", account_id, { date: localDay(-3) });
    // A row older than the month the sync compares against keeps nothing.
    await seedTransaction(stack, adminId, account_id, { transaction_id: "sync-mod-old", date: localDay(-45), label_memo: "too old to carry" });

    stack.upstream.plaid.addSyncPage(access_token, {
      added: [
        plaidTransaction({ transaction_id: "sync-mod-pending", account_id, date: localDay(-3), pending: true }),
        plaidTransaction({ transaction_id: "sync-mod-old", account_id, date: localDay(-45) }),
      ],
      modified: [plaidTransaction({ transaction_id: "sync-mod-kept", account_id, date: localDay(-3), amount: 12.5 })],
      removed: [{ account_id, transaction_id: "sync-mod-gone" }],
    });
    expect(await syncViaWebhook(item_id)).toEqual({ itemId: item_id, added: 2, modified: 1, removed: 1 });

    expect(await rowOf(stack, "transactions", "sync-mod-kept")).toMatchObject({ amount: 12.5, label_memo: "mine" });
    expect(await rowOf(stack, "transactions", "sync-mod-pending")).toMatchObject({ label_memo: "from the posted row", pending: true });
    expect(await rowOf(stack, "transactions", "sync-mod-gone")).toMatchObject({ is_deleted: true });
    expect(await rowOf(stack, "split_transactions", goneSplit)).toMatchObject({ is_deleted: true });
    expect(await rowOf(stack, "transactions", "sync-mod-old")).toMatchObject({ label_memo: "too old to carry" });
  });

  test("leaves a posted row's own splits alone, tombstoning the pending row's, when the posted row already has some", async () => {
    const account_id = "sync-split-account";
    const { item_id, access_token } = await plaidItem(adminId, "sync-split", { available_products: ["transactions"] });
    await seedAccount(stack, adminId, item_id, { account_id });
    await seedTransaction(stack, adminId, account_id, { transaction_id: "sync-split-pending", date: localDay(-2), pending: true });
    await seedTransaction(stack, adminId, account_id, { transaction_id: "sync-split-posted", date: localDay(-1) });
    const pendingSplit = await seedSplitTransaction(stack, adminId, "sync-split-pending", account_id, { date: localDay(-2) });
    const postedSplit = await seedSplitTransaction(stack, adminId, "sync-split-posted", account_id, { date: localDay(-1) });

    stack.upstream.plaid.addSyncPage(access_token, {
      modified: [plaidTransaction({ transaction_id: "sync-split-posted", pending_transaction_id: "sync-split-pending", account_id, date: localDay(-1) })],
      removed: [{ account_id, transaction_id: "sync-split-pending" }],
    });
    expect(await syncViaWebhook(item_id)).toEqual({ itemId: item_id, added: 0, modified: 1, removed: 1 });
    expect(stack.logCount(`Skipping split re-point: posted transaction already has live splits {"pending":"sync-split-pending","posted":"sync-split-posted"}`)).toBe(1);
    expect(await rowOf(stack, "split_transactions", postedSplit)).toMatchObject({ transaction_id: "sync-split-posted", is_deleted: false });
    expect(await rowOf(stack, "split_transactions", pendingSplit)).toMatchObject({ transaction_id: "sync-split-pending", is_deleted: true });
  });

  test("asks for each next page once the one before has answered, and for the investment transactions once, and stores the cursor", async () => {
    const brokerage = "sync-pages-brokerage";
    const { item_id, access_token } = await plaidItem(
      adminId,
      "sync-pages",
      {},
      {
        accounts: [plaidAccount({ account_id: brokerage, type: "investment", subtype: "brokerage" })],
        investmentTransactions: [plaidInvestmentTransaction({ investment_transaction_id: "sync-pages-inv", account_id: brokerage, date: localDay(-1) })],
      },
    );
    for (let page = 1; page <= 3; page++) {
      stack.upstream.plaid.addSyncPage(access_token, { added: [plaidTransaction({ transaction_id: `sync-pages-tx-${page}`, account_id: brokerage })] });
    }
    const from = stack.upstream.plaid.seen().length;
    expect(await unordered(() => syncViaWebhook(item_id))).toEqual({ itemId: item_id, added: 4, modified: 0, removed: 0 });
    const calls = callsSince(from);
    expect(calls.filter(([, path]) => path === "/transactions/sync").map(([, , body]) => body)).toEqual([
      { access_token },
      { access_token, cursor: "cursor-1" },
      { access_token, cursor: "cursor-2" },
    ]);
    // Asked for once, as the first page is: two weeks back from when the item was stored, to today.
    expect(calls.filter(([, path]) => path === "/investments/transactions/get").map(([, , body]) => body)).toEqual([
      { access_token, start_date: localDay(-14), end_date: localDay(), options: { count: 100, offset: 0 } },
    ]);
    expect(calls).toHaveLength(4);
    expect(await rowOf(stack, "items", item_id)).toMatchObject({ cursor: "cursor-3" });
  });

  test("removes recent investment transactions Plaid no longer lists, but never manual or older ones", async () => {
    const brokerage = "sync-inv-brokerage";
    const { item_id } = await plaidItem(
      adminId,
      "sync-inv",
      { available_products: ["investments"] },
      {
        accounts: [plaidAccount({ account_id: brokerage, type: "investment", subtype: "brokerage" })],
        investmentTransactions: [
          plaidInvestmentTransaction({ investment_transaction_id: "sync-inv-kept", account_id: brokerage, date: localDay(-1), amount: 250 }),
          plaidInvestmentTransaction({ investment_transaction_id: "sync-inv-new", account_id: brokerage, date: localDay(-1) }),
        ],
      },
    );
    await seedAccount(stack, adminId, item_id, { account_id: brokerage, type: "investment" });
    const seed = (id: string, row: Row = {}) => seedInvestmentTransaction(stack, adminId, brokerage, { investment_transaction_id: id, date: localDay(-2), ...row });
    await seed("sync-inv-kept");
    await seed("sync-inv-gone");
    await seed("sync-inv-manual", { source: "manual" });
    await seed("sync-inv-old", { date: localDay(-20) });
    await seed("sync-inv-tombstone", { is_deleted: true });

    // The one still listed counts as modified rather than added; one is removed.
    expect(await syncViaWebhook(item_id)).toEqual({ itemId: item_id, added: 1, modified: 1, removed: 1 });
    const flags = async (id: string) => (await rowOf(stack, "investment_transactions", id))?.is_deleted;
    expect({
      kept: await flags("sync-inv-kept"),
      new: await flags("sync-inv-new"),
      gone: await flags("sync-inv-gone"),
      manual: await flags("sync-inv-manual"),
      old: await flags("sync-inv-old"),
    }).toEqual({ kept: false, new: false, gone: true, manual: false, old: false });
    expect(await rowOf(stack, "investment_transactions", "sync-inv-kept")).toMatchObject({ amount: 250, date: localDay(-1) });
  });
});

describe("the item's owner", () => {
  test("is who the synced rows belong to, in a sharing group too", async () => {
    const { user } = await createUserClient(stack, "sync-member");
    const { item_id, access_token } = await plaidItem(user.user_id, "sync-member-item", { available_products: ["transactions"] });
    stack.upstream.plaid.addSyncPage(access_token, { added: [plaidTransaction({ transaction_id: "sync-member-tx", account_id: "sync-member-account" })] });
    await syncViaWebhook(item_id);
    expect(await rowOf(stack, "transactions", "sync-member-tx")).toMatchObject({ user_id: user.user_id });
  });
});
