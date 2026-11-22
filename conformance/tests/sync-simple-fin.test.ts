/**
 * The SimpleFin sync, as the scheduled sync (at every start, then hourly) runs
 * it for each SimpleFin item: the item's accounts, transactions and holdings
 * from its bridge, stored with their snapshots, securities and institutions;
 * transactions the bridge no longer lists removed; and how the sync went
 * recorded on the item. A test seeds items, restarts the server, and reads
 * what the sync stored, logged and alarmed. Items are retired after each
 * test, so each start syncs only the test's own.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  SIMPLEFIN_HOST,
  simpleFinAccount,
  simpleFinHolding,
  simpleFinTransaction,
  startStack,
  type SimpleFinConnection,
  type Stack,
} from "../harness";
import type { Row } from "../harness/postgres";
import {
  rowOf,
  rowsOf,
  seedAccount,
  seedInvestmentTransaction,
  seedItem,
  seedSecurity,
  seedSplitTransaction,
  seedTransaction,
} from "../harness/seed/accounts";

// Every test restarts the server: give each the suite's 30 seconds.
setDefaultTimeout(30_000);

let stack: Stack;
let adminId: string;
beforeAll(async () => {
  stack = await startStack();
  adminId = await stack.userId("admin");
  // The cash security every inferred cash holding is of, with an id the comparison can read.
  await seedSecurity(stack, "sf-usd-cash", { ticker_symbol: "USD", name: "US Dollar Cash", type: "cash", close_price: "1" });
});
afterAll(() => stack.stop());

afterEach(async () => {
  await stack.db.query("UPDATE items SET is_deleted = TRUE");
  await stack.db.query("UPDATE holdings SET is_deleted = TRUE");
});

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const pad = (n: number) => String(n).padStart(2, "0");
/** `YYYY-MM-DD` of the local day of an epoch-seconds instant. */
const localDayOf = (seconds: number): string => {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const localDay = (days = 0): string => localDayOf(now() + days * DAY);

/** A SimpleFin item of `user_id` on `connection`, stored with `row` set. */
const simpleFinItem = async (user_id: string, item_id: string, connection: SimpleFinConnection, row: Row = {}) =>
  seedItem(stack, user_id, "simple_fin", { item_id, access_token: connection.accessUrl, institution_id: null, ...row });

const bridgeCalls = (from: number) => stack.upstream.simplefin.seen().slice(from);

const logged = (message: string): Record<string, unknown> => {
  const line = [...stack.logs].reverse().find((l) => l.includes(message));
  if (!line) throw new Error(`no "${message}" line in the log`);
  return JSON.parse(line.slice(line.indexOf("{")));
};

const alarmsTitled = (title: string) => stack.upstream.discord.alarms().filter((alarm) => alarm.title === `🚨 Budget Server Error: ${title}`);

describe("the scheduled sync of a SimpleFin item", () => {
  test("fetches two years back the first time, and stores accounts, transactions, holdings, securities and institutions", async () => {
    const connection = stack.upstream.simplefin.addConnection({
      username: "sf-full-user",
      password: "sf-full-secret",
      accounts: [
        simpleFinAccount({
          id: "sf-full-checking",
          name: "SF Checking",
          balance: "1234.56",
          "available-balance": "1200.00",
          transactions: [
            simpleFinTransaction({
              id: "sf-full-tx-1",
              amount: "-850.00",
              description: "Rent",
              payee: "Landlord",
              memo: "rent memo",
              posted: now() - 3 * DAY,
              transacted_at: now() - 4 * DAY,
            }),
            simpleFinTransaction({ id: "sf-full-tx-2", amount: "25.00", description: "Refund", pending: true, posted: now() - DAY, transacted_at: now() - DAY }),
          ],
        }),
        simpleFinAccount({
          id: "sf-full-brokerage",
          name: "SF Brokerage",
          balance: "5000.00",
          "available-balance": "0",
          holdings: [
            simpleFinHolding({ id: "sf-full-holding", symbol: "SFH", market_value: "3000.00", shares: "30", cost_basis: "2500.00", created: now() - 2 * DAY }),
            // Without a ticker there is no security to price it by: dropped.
            simpleFinHolding({ id: "sf-full-unpriced", symbol: "", market_value: "100.00", shares: "1" }),
          ],
          transactions: [simpleFinTransaction({ id: "sf-full-inv", amount: "-3000.00", description: "Buy SFH", posted: now() - 2 * DAY })],
        }),
      ],
    });
    const item_id = await simpleFinItem(adminId, "sf-full", connection, { updated: null });
    const from = stack.upstream.simplefin.seen().length;
    await stack.restart();

    const calls = bridgeCalls(from);
    expect(calls.map((call) => [call.host, call.method, call.path, Object.keys(call.query)])).toEqual([
      [SIMPLEFIN_HOST, "GET", "/simplefin/accounts", ["start-date", "end-date", "pending"]],
    ]);
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from("sf-full-user:sf-full-secret").toString("base64")}`);
    const twoYearsBack = new Date();
    twoYearsBack.setFullYear(new Date().getFullYear() - 2);
    expect(Math.abs(Number(calls[0].query["start-date"]) - Math.floor(twoYearsBack.getTime() / 1000))).toBeLessThan(120);
    expect(Math.abs(Number(calls[0].query["end-date"]) - now())).toBeLessThan(120);
    expect(calls[0].query.pending).toBe("1");

    expect(logged("Synced SimpleFin item")).toEqual({ itemId: item_id, accountsUpdated: 2, transactionsUpdated: 3 });
    expect(await rowOf(stack, "items", item_id)).toMatchObject({ last_sync_status: "success", last_sync_error: null, last_sync_at: expect.any(String) });

    const accounts = await rowsOf(stack, "accounts", { item_id });
    expect(accounts.map((a) => [a.account_id, a.name, a.type, a.subtype, a.institution_id, a.balances_current, a.balances_available, a.custom_name, a.hide])).toEqual([
      ["sf-full-brokerage", "SF Brokerage", "investment", null, "unknown", 5000, 0, "", false],
      ["sf-full-checking", "SF Checking", "other", null, "unknown", 1234.56, 1200, "", false],
    ]);
    // Only investment accounts get balance snapshots from this sync.
    const snapshots = (await rowsOf(stack, "snapshots", { snapshot_type: "account_balance" })).filter((s) => String(s.account_id).startsWith("sf-full"));
    expect(snapshots.map((s) => [s.account_id, s.balances_current])).toEqual([["sf-full-brokerage", 5000]]);

    expect(await rowOf(stack, "transactions", "sf-full-tx-1")).toMatchObject({
      account_id: "sf-full-checking",
      user_id: adminId,
      amount: -850,
      name: "Rent",
      merchant_name: "Landlord",
      label_memo: "rent memo",
      date: localDay(-4),
      pending: false,
    });
    // Pending at the bridge, but every SimpleFin transaction is stored as posted.
    expect(await rowOf(stack, "transactions", "sf-full-tx-2")).toMatchObject({ amount: 25, pending: false, date: localDay(-1) });
    expect(await rowOf(stack, "investment_transactions", "sf-full-inv")).toMatchObject({
      account_id: "sf-full-brokerage",
      amount: -3000,
      price: -3000,
      quantity: 1,
      type: "buy",
      date: localDay(-2),
    });

    const holdings = await rowsOf(stack, "holdings", { account_id: "sf-full-brokerage" });
    expect(holdings.map((h) => [h.holding_id, h.quantity, h.institution_value]).sort()).toEqual([
      ["sf-full-brokerage-sf-usd-cash", 2000, 2000],
      ["sf-full-holding", 30, 3000],
    ]);
    const security = await rowOf(stack, "securities", holdings.find((h) => h.holding_id === "sf-full-holding")!.security_id as string);
    expect(security).toMatchObject({ ticker_symbol: "SFH", close_price: 100, close_price_as_of: localDay(-2), iso_currency_code: "USD" });
    expect(await rowOf(stack, "institutions", "org-fake-bank")).toMatchObject({ name: "Fake Bank" });
  });

  test("fetches from two weeks before the last sync, keeps stored labels and settings, and removes what the bridge no longer lists", async () => {
    const connection = stack.upstream.simplefin.addConnection({
      accounts: [
        simpleFinAccount({
          id: "sf-again-checking",
          name: "Again Checking",
          transactions: [
            simpleFinTransaction({ id: "sf-again-kept", memo: "provider memo", posted: now() - 3 * DAY, transacted_at: now() - 3 * DAY }),
            simpleFinTransaction({ id: "sf-again-new", memo: "new memo", posted: now() - 2 * DAY, transacted_at: now() - 2 * DAY }),
          ],
        }),
        simpleFinAccount({
          id: "sf-again-brokerage",
          name: "Again Brokerage",
          balance: "100.00",
          holdings: [simpleFinHolding({ id: "sf-again-holding", market_value: "100.00", shares: "1" })],
          transactions: [simpleFinTransaction({ id: "sf-again-inv-kept", posted: now() - 2 * DAY })],
        }),
      ],
    });
    const updated = new Date(Date.now() - 5 * DAY * 1000);
    const item_id = await simpleFinItem(adminId, "sf-again", connection, { updated: updated.toISOString() });
    await seedAccount(stack, adminId, item_id, { account_id: "sf-again-checking", custom_name: "Bills", hide: true, type: "other" });
    await seedAccount(stack, adminId, item_id, { account_id: "sf-again-brokerage", type: "investment" });
    await seedAccount(stack, adminId, item_id, { account_id: "sf-again-closed", type: "other" });
    const tx = (transaction_id: string, row: Row = {}) =>
      seedTransaction(stack, adminId, "sf-again-checking", { transaction_id, date: localDay(-3), ...row });
    await tx("sf-again-kept", { label_memo: "my own memo" });
    await tx("sf-again-gone");
    const goneSplit = await seedSplitTransaction(stack, adminId, "sf-again-gone", "sf-again-checking", { date: localDay(-3) });
    await tx("sf-again-manual", { source: "manual" });
    await tx("sf-again-old", { date: localDay(-30) });
    await seedTransaction(stack, adminId, "sf-again-closed", { transaction_id: "sf-again-other-account", date: localDay(-3) });
    const inv = (id: string) => seedInvestmentTransaction(stack, adminId, "sf-again-brokerage", { investment_transaction_id: id, date: localDay(-2) });
    await inv("sf-again-inv-kept");
    await inv("sf-again-inv-gone");

    const from = stack.upstream.simplefin.seen().length;
    await stack.restart();

    const start = new Date(updated);
    start.setDate(start.getDate() - 14);
    expect(Number(bridgeCalls(from)[0].query["start-date"])).toBe(Math.floor(start.getTime() / 1000));
    expect(logged("Synced SimpleFin item")).toEqual({ itemId: item_id, accountsUpdated: 2, transactionsUpdated: 3 });

    expect(await rowOf(stack, "accounts", "sf-again-checking")).toMatchObject({ custom_name: "Bills", hide: true, name: "Again Checking" });
    expect(await rowOf(stack, "transactions", "sf-again-kept")).toMatchObject({ label_memo: "my own memo", is_deleted: false });
    expect(await rowOf(stack, "transactions", "sf-again-new")).toMatchObject({ label_memo: "new memo", is_deleted: false });
    const deleted = async (table: string, id: string) => (await rowOf(stack, table, id))?.is_deleted;
    expect({
      gone: await deleted("transactions", "sf-again-gone"),
      goneSplit: await deleted("split_transactions", goneSplit),
      manual: await deleted("transactions", "sf-again-manual"),
      old: await deleted("transactions", "sf-again-old"),
      otherAccount: await deleted("transactions", "sf-again-other-account"),
      invKept: await deleted("investment_transactions", "sf-again-inv-kept"),
      invGone: await deleted("investment_transactions", "sf-again-inv-gone"),
    }).toEqual({ gone: true, goneSplit: true, manual: false, old: false, otherAccount: false, invKept: false, invGone: true });
    // Fully invested: no cash is inferred.
    expect(await rowOf(stack, "holdings", "sf-again-brokerage-sf-usd-cash")).toBeUndefined();
    expect(await rowOf(stack, "items", item_id)).toMatchObject({ last_sync_status: "success" });
  });
});

describe("a SimpleFin sync that fails", () => {
  const failing = async (item_id: string, connection: SimpleFinConnection, row: Row, message: string, asksTheBridge: boolean) => {
    await simpleFinItem(adminId, item_id, connection, row);
    const from = stack.upstream.simplefin.seen().length;
    const synced = stack.logCount("Synced SimpleFin item");
    const alarms = alarmsTitled("Scheduled Sync Error: SimpleFin data failed").length;
    await stack.restart();
    expect(bridgeCalls(from)).toHaveLength(asksTheBridge ? 1 : 0);
    expect(stack.logCount(`Sync SimpleFin data failed {"itemId":"${item_id}"}`)).toBe(1);
    expect(stack.logCount("Synced SimpleFin item")).toBe(synced);
    await stack.waitFor(() => alarmsTitled("Scheduled Sync Error: SimpleFin data failed").length === alarms + 1, { what: "the alarm" });
    expect(alarmsTitled("Scheduled Sync Error: SimpleFin data failed").at(-1)?.description).toBe(`**Item:** ${item_id}\n**Error:** ${message}`);
    expect(await rowOf(stack, "items", item_id)).toMatchObject({ last_sync_status: "failed", last_sync_error: message });
  };

  test("because the bridge answered with an error status is logged, alarmed and recorded on the item", async () => {
    const connection = stack.upstream.simplefin.addConnection();
    stack.upstream.simplefin.fail("/simplefin/accounts", { status: 500 }, { times: 1 });
    await failing("sf-down", connection, {}, "SimpleFin API error: 500 Internal Server Error (https://bridge.simplefin.test/simplefin)", true);
  });

  test("because the bridge listed errors is logged, alarmed and recorded on the item", async () => {
    const connection = stack.upstream.simplefin.addConnection({
      accounts: [simpleFinAccount({ id: "sf-errors-account" })],
      errors: ["Connection to Fake Bank may need attention"],
    });
    await failing("sf-errors", connection, {}, 'SimpleFin API returned errors: ["Connection to Fake Bank may need attention"]', true);
    expect(await rowOf(stack, "accounts", "sf-errors-account")).toBeUndefined();
  });

  test("because the bridge answered without accounts is logged, alarmed and recorded on the item", async () => {
    const connection = stack.upstream.simplefin.addConnection();
    stack.upstream.simplefin.fail("/simplefin/accounts", { status: 200, body: '{"errors":[]}', contentType: "application/json" }, { times: 1 });
    await failing("sf-no-accounts", connection, {}, "SimpleFin API returned unexpected response shape: missing accounts array", true);
  });

  test("because its stored access URL is not one to fetch is logged, alarmed and recorded without asking anyone", async () => {
    const connection = stack.upstream.simplefin.addConnection();
    await failing(
      "sf-plain-http",
      connection,
      { access_token: "http://user:secret@bridge.simplefin.test/simplefin" },
      "Invalid SimpleFin access URL: URL must use HTTPS (got http:)",
      false,
    );
  });

  test("of one item does not stop the next, nor a server without Plaid credentials from syncing SimpleFin", async () => {
    const unconfigured = await startStack({ env: { PLAID_CLIENT_ID: undefined } });
    try {
      const owner = await unconfigured.userId("admin");
      const connection = unconfigured.upstream.simplefin.addConnection({ accounts: [simpleFinAccount({ id: "sf-unconfigured-account" })] });
      // An item that fails without asking the bridge, so the items may be synced in either order.
      await seedItem(unconfigured, owner, "simple_fin", { item_id: "sf-unconfigured-broken", access_token: "not a url" });
      await seedItem(unconfigured, owner, "simple_fin", { item_id: "sf-unconfigured", access_token: connection.accessUrl });
      await seedItem(unconfigured, owner, "plaid", { item_id: "sf-unconfigured-plaid" });
      await unconfigured.restart();
      expect(unconfigured.logCount("Plaid is not configured — skipping Plaid sync for all items")).toBe(2);
      expect(unconfigured.upstream.plaid.seen()).toEqual([]);
      expect(unconfigured.upstream.simplefin.seen("/simplefin/accounts")).toHaveLength(1);
      expect(await rowOf(unconfigured, "accounts", "sf-unconfigured-account")).toMatchObject({ item_id: "sf-unconfigured" });
      expect(await rowOf(unconfigured, "items", "sf-unconfigured")).toMatchObject({ last_sync_status: "success" });
      expect(await rowOf(unconfigured, "items", "sf-unconfigured-broken")).toMatchObject({
        last_sync_status: "failed",
        last_sync_error: "Invalid SimpleFin access URL: URL is malformed",
      });
      expect(await rowOf(unconfigured, "items", "sf-unconfigured-plaid")).toMatchObject({ last_sync_status: null });
    } finally {
      await unconfigured.stop();
    }
  });
});
