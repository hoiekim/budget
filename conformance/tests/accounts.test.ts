/**
 * Accounts: `GET /accounts`, `POST /account`, `DELETE /account` and
 * `GET /new-account`, including what data sharing changes about each.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUserClient, startStack, type ApiClient, type Stack } from "../harness";
import { NO_SUCH_ID } from "../harness/query-cases";
import { seedApiKey, seedBudget, withInsertsDropped } from "../harness/seed/budgets";
import {
  deletedFlags,
  rowOf,
  rowsOf,
  seedAccount,
  seedAccountSnapshot,
  seedHolding,
  seedHoldingSnapshot,
  seedInvestmentTransaction,
  seedItem,
  seedSecurity,
  seedSplitTransaction,
  seedTransaction,
  seedTransactionPair,
  shareData,
  softDeleteRow,
  type StoredRow,
} from "../harness/seed/accounts";

let stack: Stack;
let admin: ApiClient;
let adminId: string;
/** A stranger to `admin`: shares nothing with anyone. */
let stranger: ApiClient;
let strangerId: string;
/** Shares data with `admin`. */
let partner: ApiClient;
let partnerId: string;
beforeAll(async () => {
  stack = await startStack();
  admin = await stack.login();
  adminId = await stack.userId("admin");
  ({ client: stranger, user: { user_id: strangerId } } = await createUserClient(stack, "accounts-stranger"));
  ({ client: partner, user: { user_id: partnerId } } = await createUserClient(stack, "accounts-partner"));
  await shareData(stack, adminId, partnerId);
});
afterAll(() => stack.stop());

const SUCCESS = { status: "success" };
const SERVER_ERROR = { status: "error", message: "Internal server error" };
const failed = (message: string) => ({ status: "failed", message });
const MANUAL_ACCOUNT_ID = /^manual-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A timestamp as the servers write one: to the millisecond, so the seeded value and the answered one agree. */
const STAMP = "2026-03-04T05:06:07.890Z";

const alarmsFor = (route: string) =>
  stack.upstream.discord.alarms().filter((alarm) => alarm.title === `🚨 Budget Server Error: Route Error: ${route}`);

/** A user of their own, so what they list is exactly what the test gave them. */
const freshUser = async (name: string): Promise<{ client: ApiClient; user_id: string }> => {
  const { client, user } = await createUserClient(stack, name);
  return { client, user_id: user.user_id };
};

const stored = async (account_id: string): Promise<StoredRow> => {
  const row = await rowOf(stack, "accounts", account_id);
  if (!row) throw new Error(`no account ${account_id}`);
  return row;
};

/** What the API answers for a stored account. */
const accountJson = (row: StoredRow): Record<string, unknown> => {
  const json: Record<string, unknown> = {
    account_id: row.account_id,
    item_id: row.item_id,
    institution_id: row.institution_id,
    name: row.name,
    type: row.type,
    subtype: row.subtype,
    mask: null,
    official_name: null,
    balances: {
      available: row.balances_available,
      current: row.balances_current,
      limit: row.balances_limit,
      iso_currency_code: row.balances_iso_currency_code,
      unofficial_currency_code: null,
    },
    custom_name: row.custom_name,
    hide: row.hide,
    archived: row.archived ?? false,
    label: { budget_id: row.label_budget_id },
    graphOptions: {
      useSnapshots: row.graph_options_use_snapshots,
      useHoldingSnapshots: row.graph_options_use_holding_snapshots ?? true,
      useTransactions: row.graph_options_use_transactions,
    },
  };
  const mappings = row.plan_fund_mappings as Record<string, { security_id: unknown; restated: unknown }> | null;
  if (mappings) {
    json.plan_fund_mappings = Object.entries(mappings).map(([investment, m]) => ({ investment, security_id: m.security_id, restated: m.restated }));
  }
  return json;
};

/** What the API answers for a stored item: no credential, and the optional fields only when set. */
const itemJson = (row: StoredRow): Record<string, unknown> => {
  const json: Record<string, unknown> = {
    item_id: row.item_id,
    user_id: row.user_id,
    institution_id: row.institution_id,
    available_products: row.available_products,
    provider: row.provider,
  };
  for (const key of ["cursor", "status", "status_reason", "updated", "last_sync_status", "last_sync_at", "last_sync_error"]) {
    // A timestamp is answered as an ISO string, to the millisecond.
    if (row[key]) json[key] = key === "updated" || key === "last_sync_at" ? new Date(String(row[key])).toISOString() : row[key];
  }
  return json;
};

const holdingJson = (row: StoredRow): Record<string, unknown> => ({
  holding_id: row.holding_id,
  account_id: row.account_id,
  security_id: row.security_id,
  institution_price: row.institution_price,
  institution_price_as_of: row.institution_price_as_of,
  institution_value: row.institution_value,
  cost_basis: row.cost_basis,
  quantity: row.quantity,
  iso_currency_code: row.iso_currency_code,
  unofficial_currency_code: null,
});

interface AccountsBody {
  items: Record<string, unknown>[];
  accounts: Record<string, unknown>[];
  holdings: Record<string, unknown>[];
}

const by = (key: string) => (rows: Record<string, unknown>[]) => [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])));

const listed = async (client: ApiClient): Promise<AccountsBody> => {
  const result = await client.get<AccountsBody>("/accounts");
  expect(result.status).toBe(200);
  expect(result.json.status).toBe("success");
  return { items: by("item_id")(result.body.items), accounts: by("account_id")(result.body.accounts), holdings: by("holding_id")(result.body.holdings) };
};

describe("a caller without a session", () => {
  let item_id: string;
  let account_id: string;
  beforeAll(async () => {
    item_id = await seedItem(stack, adminId, "manual");
    account_id = await seedAccount(stack, adminId, item_id);
  });

  const requests = (): [string, string, unknown?][] => [
    ["GET", "/accounts"],
    ["GET", `/new-account?item_id=${item_id}`],
    ["POST", "/account", { account_id, name: "Taken" }],
    ["DELETE", `/account?id=${account_id}`],
  ];
  const everything = async () => ({ items: await rowsOf(stack, "items"), accounts: await rowsOf(stack, "accounts") });

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
    const key = await seedApiKey(stack, adminId, ["transactions:suggest", "accounts:read", "accounts:write"]);
    const before = await everything();
    const keyed = stack.anonymous();
    for (const [method, path, body] of requests()) {
      const result = await keyed.request(method, path, { body, headers: { Authorization: `Bearer ${key}`, "X-Real-IP": "10.50.0.1" } });
      expect([method, path, result.status]).toEqual([method, path, 401]);
      expect(result.json).toEqual(failed("Not authenticated."));
    }
    expect(await everything()).toEqual(before);
  });
});

describe("GET /accounts", () => {
  test("answers empty lists for a user with nothing", async () => {
    const { client } = await freshUser("accounts-empty");
    const result = await client.get("/accounts");
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "success", body: { items: [], accounts: [], holdings: [] } });
  });

  test("lists items of every provider and status without their credentials, and every account and holding", async () => {
    const { client, user_id } = await freshUser("accounts-lister");
    const plaid = await seedItem(stack, user_id, "plaid", {
      item_id: "list-plaid",
      institution_id: "ins_3",
      available_products: ["transactions", "investments"],
      cursor: "cursor-7",
      status: "ok",
      last_sync_status: "success",
      last_sync_at: STAMP,
      updated: STAMP,
    });
    const simpleFin = await seedItem(stack, user_id, "simple_fin", {
      item_id: "list-simplefin",
      status: "bad",
      status_reason: "ITEM_LOGIN_REQUIRED",
      last_sync_status: "failed",
      last_sync_error: "SimpleFin API error: 403 Forbidden",
      updated: STAMP,
    });
    // Empty and null optional fields are left out; a manual item has no credential or institution.
    const manual = await seedItem(stack, user_id, "manual", {
      item_id: "list-manual",
      available_products: null,
      cursor: "",
      status: null,
      status_reason: "",
      updated: null,
    });
    const checking = await seedAccount(stack, user_id, plaid, { account_id: "list-a-checking", label_budget_id: NO_SUCH_ID, custom_name: "Bills" });
    const credit = await seedAccount(stack, user_id, simpleFin, {
      account_id: "list-b-credit",
      type: "credit",
      subtype: "credit card",
      balances_available: null,
      balances_current: "-1234.56",
      balances_limit: "5000",
      hide: true,
      archived: null,
      graph_options_use_snapshots: false,
      graph_options_use_holding_snapshots: null,
      graph_options_use_transactions: false,
    });
    const brokerage = await seedAccount(stack, user_id, manual, {
      account_id: "list-c-brokerage",
      institution_id: "Unknown",
      type: "investment",
      subtype: "401k",
      name: null,
      balances_iso_currency_code: null,
      archived: true,
      plan_fund_mappings: { "Fund A": { security_id: "sec-a", restated: false }, "Fund B": { security_id: null, restated: true } },
    });
    await seedSecurity(stack, "list-sec");
    const holding = await seedHolding(stack, user_id, brokerage, "list-sec", { institution_price: "12.345678", quantity: "3.5" });
    const nullHolding = await seedHolding(stack, user_id, brokerage, "list-sec-2", {
      institution_price: null,
      institution_price_as_of: null,
      institution_value: null,
      cost_basis: null,
      quantity: null,
      iso_currency_code: null,
    });

    const body = await listed(client);
    expect(body).toEqual({
      items: [itemJson((await rowOf(stack, "items", manual))!), itemJson((await rowOf(stack, "items", plaid))!), itemJson((await rowOf(stack, "items", simpleFin))!)],
      accounts: [accountJson(await stored(checking)), accountJson(await stored(credit)), accountJson(await stored(brokerage))],
      holdings: by("holding_id")([holdingJson((await rowOf(stack, "holdings", holding))!), holdingJson((await rowOf(stack, "holdings", nullHolding))!)]),
    });
    // Spelled out once, so the projection above is pinned to what the client reads.
    expect(body.items.find((item) => item.item_id === plaid)).toEqual({
      item_id: plaid,
      user_id,
      institution_id: "ins_3",
      available_products: ["transactions", "investments"],
      cursor: "cursor-7",
      status: "ok",
      provider: "plaid",
      updated: STAMP,
      last_sync_status: "success",
      last_sync_at: STAMP,
    });
    expect(body.items.find((item) => item.item_id === manual)).toEqual({
      item_id: manual,
      user_id,
      institution_id: null,
      available_products: null,
      provider: "manual",
    });
    expect(body.accounts.find((account) => account.account_id === credit)).toEqual({
      account_id: credit,
      item_id: simpleFin,
      institution_id: "ins_109508",
      name: "Seeded Checking",
      type: "credit",
      subtype: "credit card",
      mask: null,
      official_name: null,
      balances: { available: null, current: -1234.56, limit: 5000, iso_currency_code: "USD", unofficial_currency_code: null },
      custom_name: null,
      hide: true,
      archived: false,
      label: { budget_id: null },
      graphOptions: { useSnapshots: false, useHoldingSnapshots: true, useTransactions: false },
    });
    expect(body.accounts.find((account) => account.account_id === brokerage)?.plan_fund_mappings).toEqual([
      { investment: "Fund A", security_id: "sec-a", restated: false },
      { investment: "Fund B", security_id: null, restated: true },
    ]);
    expect(body.holdings.find((h) => h.holding_id === holding)).toMatchObject({ institution_price: 12.345678, quantity: 3.5, institution_price_as_of: "2026-03-04" });
    for (const item of body.items) expect(item).not.toHaveProperty("access_token");
  });

  test("leaves out soft-deleted items, accounts and holdings", async () => {
    const { client, user_id } = await freshUser("accounts-deleted");
    const live = await seedItem(stack, user_id, "manual", { item_id: "deleted-live-item" });
    const gone = await seedItem(stack, user_id, "plaid", { item_id: "deleted-gone-item", is_deleted: true });
    const liveAccount = await seedAccount(stack, user_id, live, { account_id: "deleted-live-account" });
    await seedAccount(stack, user_id, live, { account_id: "deleted-gone-account", is_deleted: true });
    // An account is listed whatever state its item is in: the row is what is deleted or not.
    const underGone = await seedAccount(stack, user_id, gone, { account_id: "deleted-under-gone-item" });
    const liveHolding = await seedHolding(stack, user_id, liveAccount, "sec-live");
    await seedHolding(stack, user_id, liveAccount, "sec-gone", { is_deleted: true });

    const body = await listed(client);
    expect(body.items.map((item) => item.item_id)).toEqual([live]);
    expect(body.accounts.map((account) => account.account_id)).toEqual([liveAccount, underGone]);
    expect(body.holdings.map((h) => h.holding_id)).toEqual([liveHolding]);
  });

  test("lists what the sharing group owns, each item naming its owner, and nothing of anyone else's", async () => {
    const one = await freshUser("accounts-group-one");
    const two = await freshUser("accounts-group-two");
    const outsider = await freshUser("accounts-group-outsider");
    await shareData(stack, one.user_id, two.user_id);
    const oneItem = await seedItem(stack, one.user_id, "plaid", { item_id: "group-one-item" });
    const twoItem = await seedItem(stack, two.user_id, "simple_fin", { item_id: "group-two-item" });
    const outsiderItem = await seedItem(stack, outsider.user_id, "manual", { item_id: "group-outsider-item" });
    const oneAccount = await seedAccount(stack, one.user_id, oneItem, { account_id: "group-one-account" });
    const twoAccount = await seedAccount(stack, two.user_id, twoItem, { account_id: "group-two-account", type: "investment" });
    await seedAccount(stack, outsider.user_id, outsiderItem, { account_id: "group-outsider-account" });
    const twoHolding = await seedHolding(stack, two.user_id, twoAccount, "sec-group");
    await seedHolding(stack, outsider.user_id, "group-outsider-account", "sec-group");

    const asOne = await listed(one.client);
    const asTwo = await listed(two.client);
    expect(asOne).toEqual(asTwo);
    expect(asOne.items.map((item) => [item.item_id, item.user_id])).toEqual([
      [oneItem, one.user_id],
      [twoItem, two.user_id],
    ]);
    expect(asOne.accounts.map((account) => account.account_id)).toEqual([oneAccount, twoAccount]);
    expect(asOne.holdings.map((h) => h.holding_id)).toEqual([twoHolding]);

    const asOutsider = await listed(outsider.client);
    expect(asOutsider.items.map((item) => item.item_id)).toEqual([outsiderItem]);
    expect(asOutsider.accounts.map((account) => account.account_id)).toEqual(["group-outsider-account"]);
    expect(asOutsider.holdings.map((h) => h.account_id)).toEqual(["group-outsider-account"]);
  });
});

describe("GET /new-account", () => {
  const mint = (query: string, client: ApiClient = admin) => client.get<{ account_id: string; name: string }>(`/new-account${query}`);

  test("needs one item id", async () => {
    const before = await rowsOf(stack, "accounts");
    for (const [query, message] of [
      ["", "Missing required parameter: item_id"],
      ["?id=x", "Missing required parameter: item_id"],
      ["?item_id=a&item_id=b", "Parameter item_id must be a single value, not an array"],
      ["?item_id=", "Parameter item_id cannot be empty"],
      ["?item_id=%20%09", "Parameter item_id cannot be empty"],
    ]) {
      const result = await mint(query);
      expect([query, result.status, result.json]).toEqual([query, 200, failed(message)]);
    }
    expect(await rowsOf(stack, "accounts")).toEqual(before);
  });

  test("mints an unnamed manual account on the caller's manual item, owned by the caller", async () => {
    const item_id = await seedItem(stack, adminId, "manual", { item_id: "mint-own-manual" });
    const result = await mint(`?item_id=${item_id}`);
    expect(result.status).toBe(200);
    const { account_id } = result.body;
    expect(account_id).toMatch(MANUAL_ACCOUNT_ID);
    expect(result.json).toEqual({ status: "success", body: { account_id, name: "Unknown" } });

    const row = await stored(account_id);
    expect(row).toEqual({
      account_id,
      user_id: adminId,
      item_id,
      institution_id: "Unknown",
      name: "Unknown",
      type: "other",
      subtype: null,
      balances_available: null,
      balances_current: null,
      balances_limit: null,
      balances_iso_currency_code: null,
      custom_name: null,
      hide: false,
      archived: false,
      label_budget_id: null,
      graph_options_use_snapshots: true,
      graph_options_use_holding_snapshots: true,
      graph_options_use_transactions: true,
      plan_fund_mappings: null,
      raw: null,
      updated: expect.any(String),
      is_deleted: false,
    });
    expect((await listed(admin)).accounts.find((account) => account.account_id === account_id)).toEqual(accountJson(row));
    // The partner sees it too.
    expect((await listed(partner)).accounts.map((account) => account.account_id)).toContain(account_id);
  });

  test("mints on a sharing-group member's manual item under that member, the item's owner", async () => {
    const item_id = await seedItem(stack, partnerId, "manual", { item_id: "mint-partner-manual" });
    const result = await mint(`?item_id=${item_id}`);
    expect(result.json.status).toBe("success");
    const row = await stored(result.body.account_id);
    expect(row.user_id).toBe(partnerId);
    expect(row.item_id).toBe(item_id);
  });

  test("refuses an item that does not exist, is deleted, or is a stranger's, minting nothing", async () => {
    const deleted = await seedItem(stack, adminId, "manual", { item_id: "mint-deleted-manual", is_deleted: true });
    const strangers = await seedItem(stack, strangerId, "manual", { item_id: "mint-strangers-manual" });
    const before = await rowsOf(stack, "accounts");
    for (const item_id of ["mint-no-such-item", deleted, strangers]) {
      expect((await mint(`?item_id=${item_id}`)).json).toEqual(failed("Item not found."));
    }
    // The stranger, asking for the partner's item, is refused the same way.
    const partners = await seedItem(stack, partnerId, "manual", { item_id: "mint-partner-manual-2" });
    expect((await mint(`?item_id=${partners}`, stranger)).json).toEqual(failed("Item not found."));
    expect(await rowsOf(stack, "accounts")).toEqual(before);
  });

  test("refuses a Plaid or SimpleFin item: their accounts come from the provider", async () => {
    const before = await rowsOf(stack, "accounts");
    for (const provider of ["plaid", "simple_fin"] as const) {
      const item_id = await seedItem(stack, adminId, provider, { item_id: `mint-${provider}` });
      expect((await mint(`?item_id=${item_id}`)).json).toEqual(failed("Manual accounts can only be created on manual items."));
    }
    const partnerPlaid = await seedItem(stack, partnerId, "plaid", { item_id: "mint-partner-plaid" });
    expect((await mint(`?item_id=${partnerPlaid}`)).json).toEqual(failed("Manual accounts can only be created on manual items."));
    expect(await rowsOf(stack, "accounts")).toEqual(before);
  });

  test("answers a failure when the insert stores nothing", async () => {
    const item_id = await seedItem(stack, adminId, "manual", { item_id: "mint-dropped" });
    const result = await withInsertsDropped(stack, "accounts", () => mint(`?item_id=${item_id}`));
    expect(result.status).toBe(200);
    expect(result.json).toEqual(failed("Failed to create account."));
    expect(await rowsOf(stack, "accounts", { item_id })).toEqual([]);
  });
});

describe("POST /account", () => {
  const post = (body: unknown, client: ApiClient = admin) => client.post("/account", body);
  let item_id: string;
  beforeAll(async () => {
    item_id = await seedItem(stack, adminId, "manual", { item_id: "post-item" });
  });
  const freshAccount = async (row: Record<string, unknown> = {}) => seedAccount(stack, adminId, item_id, row);

  describe("validation", () => {
    let account_id: string;
    let before: StoredRow;
    beforeAll(async () => {
      account_id = await freshAccount({ account_id: "post-validation" });
      before = await stored(account_id);
    });

    const refused = async (body: unknown, message: string) => {
      const result = await post(body);
      expect([JSON.stringify(body), result.status, result.json]).toEqual([JSON.stringify(body), 200, failed(message)]);
    };

    test("needs a body that is an object", async () => {
      await refused(undefined, "Request body is required");
      await refused(null, "Request body is required");
      for (const body of [[], [{ account_id: "post-validation" }], "post-validation", 5, true]) {
        await refused(body, "Request body must be an object");
      }
      expect(await stored(account_id)).toEqual(before);
    });

    test("needs an account_id that is a string, before any other field", async () => {
      await refused({}, "Missing required field: account_id");
      await refused({ account_id: null, name: "x" }, "Missing required field: account_id");
      await refused({ name: 5 }, "Missing required field: account_id");
      for (const bad of [5, true, {}, [], 0]) await refused({ account_id: bad, name: "x" }, "Field account_id must be a string");
      expect(await stored(account_id)).toEqual(before);
    });

    type Kind = "string" | "boolean" | "uuid" | "number";
    const SPECS: { path: string; kind: Kind; maxLength?: number }[] = [
      { path: "name", kind: "string", maxLength: 255 },
      { path: "type", kind: "string", maxLength: 50 },
      { path: "subtype", kind: "string", maxLength: 100 },
      { path: "custom_name", kind: "string" },
      { path: "hide", kind: "boolean" },
      { path: "archived", kind: "boolean" },
      { path: "label.budget_id", kind: "uuid" },
      { path: "balances.available", kind: "number" },
      { path: "balances.current", kind: "number" },
      { path: "balances.limit", kind: "number" },
      { path: "balances.iso_currency_code", kind: "string", maxLength: 10 },
      { path: "graphOptions.useSnapshots", kind: "boolean" },
      { path: "graphOptions.useHoldingSnapshots", kind: "boolean" },
      { path: "graphOptions.useTransactions", kind: "boolean" },
    ];
    const WRONG: Record<Kind, unknown[]> = {
      string: [5, 0, true, {}, [], ["text"]],
      boolean: ["true", "", 1, 0, {}, []],
      uuid: ["not-a-uuid", NO_SUCH_ID.replace(/-/g, ""), `{${NO_SUCH_ID}}`, ` ${NO_SUCH_ID}`, 5, true, {}, []],
      number: ["5", "", true, {}, [], [5]],
    };
    /** `{ account_id, <path>: value }` with the path's parents made. */
    const bodyWith = (path: string, value: unknown) => {
      const [first, second] = path.split(".");
      return second === undefined ? { account_id, [first]: value } : { account_id, [first]: { [second]: value } };
    };

    for (const spec of SPECS) {
      test(`refuses ${spec.path} of the wrong type`, async () => {
        for (const value of WRONG[spec.kind]) await refused(bodyWith(spec.path, value), `Field ${spec.path} must be a ${spec.kind}`);
        expect(await stored(account_id)).toEqual(before);
      });
    }

    test("refuses a string past its column, counting UTF-16 units, and a balance past DECIMAL(15, 2)", async () => {
      for (const spec of SPECS.filter((s) => s.maxLength !== undefined)) {
        await refused(bodyWith(spec.path, "x".repeat(spec.maxLength! + 1)), `Field ${spec.path} must be at most ${spec.maxLength} characters`);
        // An emoji is two units: half the length plus one is one too many.
        await refused(bodyWith(spec.path, "😀".repeat(Math.floor(spec.maxLength! / 2) + 1)), `Field ${spec.path} must be at most ${spec.maxLength} characters`);
      }
      for (const path of ["balances.available", "balances.current", "balances.limit"]) {
        for (const value of [10000000000000, -10000000000000, 9999999999999.995, 1e300]) {
          await refused(bodyWith(path, value), `Field ${path} must be at most 9999999999999.99`);
        }
      }
      expect(await stored(account_id)).toEqual(before);
    });

    test("refuses a parent of a typed field that is not an object, and passes over a null one", async () => {
      for (const parent of ["label", "balances", "graphOptions"]) {
        for (const value of [5, "x", true, [], [{}]]) await refused({ account_id, [parent]: value }, `Field ${parent} must be an object`);
      }
      expect(await stored(account_id)).toEqual(before);
      // Null parents set nothing, and an edit that sets nothing reads as a missing account.
      expect((await post({ account_id, label: null, balances: null, graphOptions: null })).json).toEqual(failed("Account not found."));
      expect((await post({ account_id, label: null, balances: null, graphOptions: null, hide: false })).json).toEqual({
        status: "success",
        body: { account_id },
      });
      expect((await stored(account_id)).hide).toBe(false);
    });

    test("names the first wrong field in the order the fields are checked, not the order they are sent", async () => {
      await refused({ account_id, hide: "x", name: 5 }, "Field name must be a string");
      await refused({ account_id, graphOptions: { useTransactions: 1 }, balances: { current: "5" } }, "Field balances.current must be a number");
      await refused({ account_id, label: { budget_id: "x" }, balances: 5 }, "Field label.budget_id must be a uuid");
      await refused({ account_id, balances: { iso_currency_code: 5, available: "5" } }, "Field balances.available must be a number");
    });
  });

  test("stores the values at each column's bound, and nulls in every nullable field", async () => {
    const account_id = await freshAccount({ account_id: "post-bounds", hide: true, archived: true, custom_name: "Named", label_budget_id: NO_SUCH_ID });
    const atBound = {
      account_id,
      name: "n".repeat(255),
      type: "t".repeat(50),
      subtype: "s".repeat(100),
      balances: { available: 9999999999999.99, current: -9999999999999.99, limit: 0, iso_currency_code: "c".repeat(10) },
    };
    expect((await post(atBound)).json).toEqual({ status: "success", body: { account_id } });
    expect(await stored(account_id)).toMatchObject({
      name: atBound.name,
      type: atBound.type,
      subtype: atBound.subtype,
      balances_available: 9999999999999.99,
      balances_current: -9999999999999.99,
      balances_limit: 0,
      balances_iso_currency_code: "cccccccccc",
    });
    // 127 emoji and one letter: 255 UTF-16 units, 128 characters.
    const emoji = "😀".repeat(127) + "x";
    expect((await post({ account_id, name: emoji })).json).toEqual({ status: "success", body: { account_id } });
    expect((await stored(account_id)).name).toBe(emoji);

    const nulls = {
      account_id,
      name: null,
      type: null,
      subtype: null,
      custom_name: null,
      hide: null,
      archived: null,
      label: { budget_id: null },
      balances: { available: null, current: null, limit: null, iso_currency_code: null },
      graphOptions: { useSnapshots: null, useHoldingSnapshots: null, useTransactions: null },
    };
    expect((await post(nulls)).json).toEqual({ status: "success", body: { account_id } });
    const row = await stored(account_id);
    expect(row).toMatchObject({
      name: null,
      type: null,
      subtype: null,
      custom_name: null,
      hide: null,
      archived: null,
      label_budget_id: null,
      balances_available: null,
      balances_current: null,
      balances_limit: null,
      balances_iso_currency_code: null,
      graph_options_use_snapshots: null,
      graph_options_use_holding_snapshots: null,
      graph_options_use_transactions: null,
    });
    // Archived and holding snapshots read as their defaults when null.
    expect((await listed(admin)).accounts.find((account) => account.account_id === account_id)).toEqual(accountJson(row));
    expect(accountJson(row)).toMatchObject({ archived: false, hide: null, graphOptions: { useSnapshots: null, useHoldingSnapshots: true, useTransactions: null } });
  });

  const ACCOUNT_TYPES: [string, (string | null)[]][] = [
    ["depository", ["checking", "savings", "cd", "money market", "hsa", "cash management", "prepaid", "paypal", "ebt"]],
    ["credit", ["credit card", "paypal"]],
    ["loan", ["auto", "business", "commercial", "construction", "consumer", "home equity", "line of credit", "loan", "mortgage", "overdraft", "student", "other"]],
    [
      "investment",
      ["401k", "403B", "457b", "529", "brokerage", "crypto exchange", "hsa", "ira", "mutual fund", "pension", "retirement", "roth", "roth 401k", "stock plan", "non-taxable brokerage account", "other"],
    ],
    ["brokerage", [null, "brokerage"]],
    ["other", [null, "other"]],
  ];

  test("stores every account type and subtype, and lists it back", async () => {
    const account_id = await freshAccount({ account_id: "post-types" });
    for (const [type, subtypes] of ACCOUNT_TYPES) {
      for (const subtype of subtypes) {
        expect((await post({ account_id, type, subtype })).json).toEqual({ status: "success", body: { account_id } });
        const row = await stored(account_id);
        expect([row.type, row.subtype]).toEqual([type, subtype]);
        expect((await listed(admin)).accounts.find((account) => account.account_id === account_id)).toMatchObject({ type, subtype });
      }
    }
  });

  test("stores balances, rounding to the cent, and every graph option, hide and archive flag", async () => {
    const account_id = await freshAccount({ account_id: "post-balances" });
    const before = await stored(account_id);
    expect(
      (
        await post({
          account_id,
          balances: { available: 12.345, current: 0.004, limit: 1500, iso_currency_code: "EUR", unofficial_currency_code: "XBT" },
          graphOptions: { useSnapshots: false, useHoldingSnapshots: false, useTransactions: false },
          hide: true,
          archived: true,
        })
      ).json,
    ).toEqual({ status: "success", body: { account_id } });
    const row = await stored(account_id);
    expect(row).toMatchObject({
      balances_available: 12.35,
      balances_current: 0,
      balances_limit: 1500,
      balances_iso_currency_code: "EUR",
      graph_options_use_snapshots: false,
      graph_options_use_holding_snapshots: false,
      graph_options_use_transactions: false,
      hide: true,
      archived: true,
    });
    expect(String(row.updated) > String(before.updated)).toBe(true);
    expect((await listed(admin)).accounts.find((account) => account.account_id === account_id)).toEqual(accountJson(row));

    // A partial body changes only what it names.
    expect((await post({ account_id, balances: { current: 7 }, graphOptions: { useTransactions: true }, hide: false })).json.status).toBe("success");
    expect(await stored(account_id)).toMatchObject({
      balances_available: 12.35,
      balances_current: 7,
      balances_limit: 1500,
      graph_options_use_snapshots: false,
      graph_options_use_transactions: true,
      hide: false,
      archived: true,
    });
  });

  test("stores a custom name of any length or script, and an empty one", async () => {
    const account_id = await freshAccount({ account_id: "post-custom-name" });
    for (const custom_name of ["Everyday", "", "家計 💰 «budget»", "x".repeat(10_000), "  padded  "]) {
      expect((await post({ account_id, custom_name })).json).toEqual({ status: "success", body: { account_id } });
      expect((await stored(account_id)).custom_name).toBe(custom_name);
    }
  });

  test("labels the account with any budget id: the caller's, a group member's, a stranger's, or none", async () => {
    const account_id = await freshAccount({ account_id: "post-label" });
    const own = await seedBudget(stack, adminId);
    const partners = await seedBudget(stack, partnerId);
    const strangers = await seedBudget(stack, strangerId);
    for (const budget_id of [own, partners, strangers, NO_SUCH_ID]) {
      expect((await post({ account_id, label: { budget_id } })).json).toEqual({ status: "success", body: { account_id } });
      expect((await stored(account_id)).label_budget_id).toBe(budget_id);
    }
    // Upper case is the same UUID, stored the way Postgres writes it.
    expect((await post({ account_id, label: { budget_id: own.toUpperCase() } })).json.status).toBe("success");
    expect((await stored(account_id)).label_budget_id).toBe(own);
    expect((await listed(admin)).accounts.find((account) => account.account_id === account_id)?.label).toEqual({ budget_id: own });
    // A label without a budget id sets nothing, which reads as a missing account; a null one clears it.
    expect((await post({ account_id, label: {} })).json).toEqual(failed("Account not found."));
    expect((await post({ account_id, label: {}, custom_name: "Labelled" })).json.status).toBe("success");
    expect((await stored(account_id)).label_budget_id).toBe(own);
    expect((await post({ account_id, label: { budget_id: null } })).json.status).toBe("success");
    expect((await stored(account_id)).label_budget_id).toBeNull();
  });

  test("never moves the account to another item or institution, nor rewrites raw or the plan's fund mappings", async () => {
    const account_id = await freshAccount({
      account_id: "post-raw",
      raw: { account_id: "post-raw", from: "provider" },
      plan_fund_mappings: { Fund: { security_id: "s", restated: false } },
    });
    const body = {
      account_id,
      item_id: "post-other-item",
      institution_id: "ins_other",
      name: "Renamed",
      mask: "1234",
      balances: { current: 5, extra: "kept" },
      custom_name: "Mine",
      hide: true,
      archived: false,
      label: { budget_id: null },
      graphOptions: { useSnapshots: true },
      plan_fund_mappings: [{ investment: "Fund", security_id: "other", restated: true }],
      anything: { nested: [1, "two"] },
    };
    expect((await post(body)).json).toEqual({ status: "success", body: { account_id } });
    const row = await stored(account_id);
    expect(row).toMatchObject({
      item_id,
      institution_id: "ins_109508",
      name: "Renamed",
      custom_name: "Mine",
      balances_current: 5,
      plan_fund_mappings: { Fund: { security_id: "s", restated: false } },
    });
    expect(row.raw).toEqual({ account_id, from: "provider" });
  });

  test("with nothing to set, writes nothing and answers Account not found", async () => {
    const account_id = await freshAccount({ account_id: "post-id-only" });
    const before = await stored(account_id);
    for (const body of [{ account_id }, { account_id, item_id: "x", institution_id: "y", mask: "1", plan_fund_mappings: [] }, { account_id, balances: {}, graphOptions: {} }]) {
      expect((await post(body)).json).toEqual(failed("Account not found."));
    }
    expect(await stored(account_id)).toEqual(before);
  });

  test("edits a sharing-group member's account, which stays theirs", async () => {
    const partnerItem = await seedItem(stack, partnerId, "plaid", { item_id: "post-partner-item" });
    const account_id = await seedAccount(stack, partnerId, partnerItem, { account_id: "post-partner-account" });
    expect((await post({ account_id, custom_name: "Ours", hide: true })).json).toEqual({ status: "success", body: { account_id } });
    expect(await stored(account_id)).toMatchObject({ user_id: partnerId, item_id: partnerItem, custom_name: "Ours", hide: true });
    // And the partner edits the caller's.
    const own = await freshAccount({ account_id: "post-own-for-partner" });
    expect((await post({ account_id: own, name: "By partner" }, partner)).json.status).toBe("success");
    expect(await stored(own)).toMatchObject({ user_id: adminId, name: "By partner" });
  });

  test("answers Account not found, changing nothing, for a missing, deleted or stranger's account", async () => {
    expect((await post({ account_id: "post-no-such-account", name: "x" })).json).toEqual(failed("Account not found."));
    expect(await rowOf(stack, "accounts", "post-no-such-account")).toBeUndefined();
    expect((await post({ account_id: "", name: "x" })).json).toEqual(failed("Account not found."));

    const deleted = await freshAccount({ account_id: "post-deleted" });
    await softDeleteRow(stack, "accounts", deleted);
    const deletedBefore = await stored(deleted);
    expect((await post({ account_id: deleted, name: "x" })).json).toEqual(failed("Account not found."));
    expect(await stored(deleted)).toEqual(deletedBefore);

    const strangerItem = await seedItem(stack, strangerId, "manual", { item_id: "post-stranger-item" });
    const strangers = await seedAccount(stack, strangerId, strangerItem, { account_id: "post-stranger-account" });
    const strangersBefore = await stored(strangers);
    expect((await post({ account_id: strangers, name: "x" })).json).toEqual(failed("Account not found."));
    expect((await post({ account_id: strangers, name: "x" }, partner)).json).toEqual(failed("Account not found."));
    expect(await stored(strangers)).toEqual(strangersBefore);
    // Nor can the stranger edit the caller's.
    const own = await freshAccount({ account_id: "post-own-vs-stranger" });
    const ownBefore = await stored(own);
    expect((await post({ account_id: own, name: "x" }, stranger)).json).toEqual(failed("Account not found."));
    expect(await stored(own)).toEqual(ownBefore);
  });

  test("fails as a server error, changing nothing, on text Postgres will not store", async () => {
    const account_id = await freshAccount({ account_id: "post-nul" });
    const before = await stored(account_id);
    const route = "POST /account";
    expect(alarmsFor(route)).toHaveLength(0);

    const result = await post({ account_id, custom_name: "nul\u0000byte", hide: true });
    expect(result.status).toBe(500);
    expect(result.json).toEqual(SERVER_ERROR);
    await stack.waitFor(() => alarmsFor(route).length > 0, { what: `the ${route} alarm` });
    expect(alarmsFor(route)[0].description).toBe("**Error:** Account update did not persist, status 500");
    await stack.waitForLog(`Failed to update account {"accountId":"${account_id}"}`);
    expect(await stored(account_id)).toEqual(before);

    // An account whose id is empty updates, but has no id to answer with.
    await freshAccount({ account_id: "" });
    const empty = await post({ account_id: "", name: "Empty" });
    expect(empty.status).toBe(500);
    expect(empty.json).toEqual(SERVER_ERROR);
    await stack.waitForLog('Failed to update account {"accountId":""}');
    // One alarm a minute per route.
    expect(alarmsFor(route)).toHaveLength(1);
  });
});

describe("DELETE /account", () => {
  const remove = (query: string, client: ApiClient = admin) => client.delete(`/account${query}`);

  test("needs one id", async () => {
    const before = await rowsOf(stack, "accounts");
    for (const [query, message] of [
      ["", "Missing required parameter: id"],
      ["?account_id=x", "Missing required parameter: id"],
      ["?id=a&id=b", "Parameter id must be a single value, not an array"],
      ["?id=", "Parameter id cannot be empty"],
      ["?id=%20", "Parameter id cannot be empty"],
    ]) {
      const result = await remove(query);
      expect([query, result.status, result.json]).toEqual([query, 200, failed(message)]);
    }
    expect(await rowsOf(stack, "accounts")).toEqual(before);
  });

  /** An account with one of everything an account holds, and the ids of each. */
  const seedFullAccount = async (user_id: string, item_id: string, tag: string, other_account_id: string) => {
    const account_id = await seedAccount(stack, user_id, item_id, { account_id: `del-${tag}` });
    const tx = await seedTransaction(stack, user_id, account_id, { transaction_id: `del-${tag}-tx` });
    const tx2 = await seedTransaction(stack, user_id, account_id, { transaction_id: `del-${tag}-tx2`, amount: "-5" });
    const split = await seedSplitTransaction(stack, user_id, tx, account_id);
    const inv = await seedInvestmentTransaction(stack, user_id, account_id, { investment_transaction_id: `del-${tag}-inv` });
    const otherTx = await seedTransaction(stack, user_id, other_account_id, { transaction_id: `del-${tag}-other-tx`, amount: "-12.34" });
    // A transfer between the account and another: deleting either side ends the pair.
    const pairOut = await seedTransactionPair(stack, user_id, tx, otherTx);
    const pairIn = await seedTransactionPair(stack, user_id, otherTx, tx2, { status: "suggested" });
    const snapshot = await seedAccountSnapshot(stack, user_id, account_id, { snapshot_id: `del-${tag}-snap` });
    await seedSecurity(stack, `del-${tag}-sec`);
    const holdingSnapshot = await seedHoldingSnapshot(stack, user_id, account_id, `del-${tag}-sec`, { snapshot_id: `del-${tag}-hsnap` });
    const holding = await seedHolding(stack, user_id, account_id, `del-${tag}-sec`);
    return { account_id, tx, tx2, split, inv, otherTx, pairOut, pairIn, snapshot, holdingSnapshot, holding };
  };

  const flagsOf = async (rows: Awaited<ReturnType<typeof seedFullAccount>>) => ({
    accounts: await deletedFlags(stack, "accounts", [rows.account_id]),
    transactions: await deletedFlags(stack, "transactions", [rows.tx, rows.tx2, rows.otherTx]),
    split_transactions: await deletedFlags(stack, "split_transactions", [rows.split]),
    investment_transactions: await deletedFlags(stack, "investment_transactions", [rows.inv]),
    transaction_pairs: await deletedFlags(stack, "transaction_pairs", [rows.pairOut, rows.pairIn]),
    snapshots: await deletedFlags(stack, "snapshots", [rows.snapshot, rows.holdingSnapshot]),
    holdings: await deletedFlags(stack, "holdings", [rows.holding]),
  });

  const deletedEverything = (rows: Awaited<ReturnType<typeof seedFullAccount>>) => ({
    accounts: { [rows.account_id]: true },
    transactions: { [rows.tx]: true, [rows.tx2]: true, [rows.otherTx]: false },
    split_transactions: { [rows.split]: true },
    investment_transactions: { [rows.inv]: true },
    transaction_pairs: { [rows.pairOut]: true, [rows.pairIn]: true },
    snapshots: { [rows.snapshot]: true, [rows.holdingSnapshot]: true },
    holdings: { [rows.holding]: true },
  });

  const untouched = (rows: Awaited<ReturnType<typeof seedFullAccount>>) => ({
    accounts: { [rows.account_id]: false },
    transactions: { [rows.tx]: false, [rows.tx2]: false, [rows.otherTx]: false },
    split_transactions: { [rows.split]: false },
    investment_transactions: { [rows.inv]: false },
    transaction_pairs: { [rows.pairOut]: false, [rows.pairIn]: false },
    snapshots: { [rows.snapshot]: false, [rows.holdingSnapshot]: false },
    holdings: { [rows.holding]: false },
  });

  test("deletes the caller's manual account and everything in it, and nothing of the account beside it", async () => {
    const item_id = await seedItem(stack, adminId, "manual", { item_id: "del-own-item" });
    const other = await seedAccount(stack, adminId, item_id, { account_id: "del-own-other" });
    const rows = await seedFullAccount(adminId, item_id, "own", other);
    const otherSnapshot = await seedAccountSnapshot(stack, adminId, other, { snapshot_id: "del-own-other-snap" });

    const result = await remove(`?id=${rows.account_id}`);
    expect(result.status).toBe(200);
    expect(result.json).toEqual(SUCCESS);
    expect(await flagsOf(rows)).toEqual(deletedEverything(rows));
    expect(await deletedFlags(stack, "accounts", [other])).toEqual({ [other]: false });
    expect(await deletedFlags(stack, "snapshots", [otherSnapshot])).toEqual({ [otherSnapshot]: false });
    expect(await deletedFlags(stack, "items", [item_id])).toEqual({ [item_id]: false });
    expect((await listed(admin)).accounts.map((account) => account.account_id)).not.toContain(rows.account_id);
    // Deleting it again finds nothing.
    expect((await remove(`?id=${rows.account_id}`)).json).toEqual(failed("Account not found."));
  });

  test("deletes a sharing-group member's manual account the same way", async () => {
    const item_id = await seedItem(stack, partnerId, "manual", { item_id: "del-partner-item" });
    const other = await seedAccount(stack, partnerId, item_id, { account_id: "del-partner-other" });
    const rows = await seedFullAccount(partnerId, item_id, "partner", other);
    expect((await remove(`?id=${rows.account_id}`)).json).toEqual(SUCCESS);
    expect(await flagsOf(rows)).toEqual(deletedEverything(rows));
  });

  test("refuses a stranger's account, a missing one and a deleted one, deleting nothing", async () => {
    const strangerItem = await seedItem(stack, strangerId, "manual", { item_id: "del-stranger-item" });
    const strangerOther = await seedAccount(stack, strangerId, strangerItem, { account_id: "del-stranger-other" });
    const rows = await seedFullAccount(strangerId, strangerItem, "stranger", strangerOther);
    expect((await remove(`?id=${rows.account_id}`)).json).toEqual(failed("Account not found."));
    expect((await remove(`?id=${rows.account_id}`, partner)).json).toEqual(failed("Account not found."));
    expect(await flagsOf(rows)).toEqual(untouched(rows));
    // The stranger can't delete the caller's either.
    const ownItem = await seedItem(stack, adminId, "manual", { item_id: "del-own-vs-stranger" });
    const own = await seedAccount(stack, adminId, ownItem, { account_id: "del-own-vs-stranger-account" });
    expect((await remove(`?id=${own}`, stranger)).json).toEqual(failed("Account not found."));
    expect(await deletedFlags(stack, "accounts", [own])).toEqual({ [own]: false });

    expect((await remove("?id=del-no-such-account")).json).toEqual(failed("Account not found."));
    const deleted = await seedAccount(stack, adminId, ownItem, { account_id: "del-already-deleted", is_deleted: true });
    expect((await remove(`?id=${deleted}`)).json).toEqual(failed("Account not found."));
  });

  test("refuses an account whose item is missing, deleted or a stranger's", async () => {
    const deletedItem = await seedItem(stack, adminId, "manual", { item_id: "del-deleted-item", is_deleted: true });
    const strangersItem = await seedItem(stack, strangerId, "manual", { item_id: "del-strangers-item" });
    for (const item_id of ["del-no-such-item", deletedItem, strangersItem]) {
      const account_id = await seedAccount(stack, adminId, item_id, { account_id: `del-orphan-${item_id}` });
      expect((await remove(`?id=${account_id}`)).json).toEqual(failed("Item not found."));
      expect(await deletedFlags(stack, "accounts", [account_id])).toEqual({ [account_id]: false });
    }
  });

  test("refuses an account of a Plaid or SimpleFin item: the provider would bring it back", async () => {
    for (const provider of ["plaid", "simple_fin"] as const) {
      for (const [who, owner] of [["admin", adminId], ["partner", partnerId]]) {
        const item_id = await seedItem(stack, owner, provider);
        const other = await seedAccount(stack, owner, item_id);
        const rows = await seedFullAccount(owner, item_id, `${provider}-${who}`, other);
        expect((await remove(`?id=${rows.account_id}`)).json).toEqual(failed("Account is not a manual account."));
        expect(await flagsOf(rows)).toEqual(untouched(rows));
      }
    }
  });
});
