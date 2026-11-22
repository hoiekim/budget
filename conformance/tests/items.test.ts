/**
 * Connections: `GET /link-token` (Plaid Link, new or in update mode) and
 * `DELETE /item` (at Plaid, then here with everything under the item).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  PLAID_PRODUCTION_HOST,
  PLAID_SANDBOX_HOST,
  createUserClient,
  startStack,
  type ApiClient,
  type Stack,
} from "../harness";
import { seedApiKey } from "../harness/seed/budgets";
import {
  deletedFlags,
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
} from "../harness/seed/accounts";

let stack: Stack;
let admin: ApiClient;
let adminId: string;
let stranger: ApiClient;
let strangerId: string;
/** Shares data with `admin`. */
let partner: ApiClient;
let partnerId: string;
beforeAll(async () => {
  stack = await startStack();
  admin = await stack.login();
  adminId = await stack.userId("admin");
  ({ client: stranger, user: { user_id: strangerId } } = await createUserClient(stack, "items-stranger"));
  ({ client: partner, user: { user_id: partnerId } } = await createUserClient(stack, "items-partner"));
  await shareData(stack, adminId, partnerId);
});
afterAll(() => stack.stop());

const SUCCESS = { status: "success" };
const SERVER_ERROR = { status: "error", message: "Internal server error" };
const failed = (message: string) => ({ status: "failed", message });
const LINK_TOKEN = (environment: string) => new RegExp(`^link-${environment}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);
const PLAID_HEADERS = {
  "plaid-client-id": "conformance-plaid-client",
  "plaid-secret": "conformance-plaid-production",
  "content-type": "application/json",
};

const alarmsFor = (s: Stack, route: string) =>
  s.upstream.discord.alarms().filter((alarm) => alarm.title === `🚨 Budget Server Error: Route Error: ${route}`);

/** The `/link/token/create` request for a user: a new link, or update mode on the item with `access_token`. */
const linkRequest = (user_id: string, access_token?: string) => ({
  user: { client_user_id: user_id },
  client_name: "Budget App",
  country_codes: ["US"],
  optional_products: ["investments"],
  language: "en",
  redirect_uri: "https://budget.example.test/config",
  webhook: "https://budget.example.test/api/plaid-hook",
  ...(access_token ? { access_token, update: { account_selection_enabled: true } } : { products: ["transactions"] }),
});

/** A Plaid item stored for `user_id` that the Plaid fake knows by the same access token. */
const plaidItem = async (s: Stack, user_id: string, item_id: string, row: Record<string, unknown> = {}) => {
  const access_token = `access-production-${item_id}`;
  await seedItem(s, user_id, "plaid", { item_id, access_token, ...row });
  s.upstream.plaid.addItem({ item_id, access_token });
  return { item_id, access_token };
};

describe("a caller without a session", () => {
  test("is refused on every route, with or without an API key, and Plaid is not asked", async () => {
    const { item_id } = await plaidItem(stack, adminId, "anon-item");
    const key = await seedApiKey(stack, adminId, ["transactions:suggest", "items:write"]);
    const before = stack.upstream.plaid.seen().length;
    for (const headers of [{}, { Authorization: `Bearer ${key}`, "X-Real-IP": "10.52.0.1" }] as Record<string, string>[]) {
      for (const [method, path] of [
        ["GET", "/link-token"],
        ["GET", `/link-token?item_id=${item_id}`],
        ["DELETE", `/item?id=${item_id}`],
      ]) {
        const result = await stack.anonymous().request(method, path, { headers });
        expect([method, path, result.status]).toEqual([method, path, 401]);
        expect(result.json).toEqual(failed("Not authenticated."));
      }
    }
    expect(stack.upstream.plaid.seen()).toHaveLength(before);
    expect(await deletedFlags(stack, "items", [item_id])).toEqual({ [item_id]: false });
  });
});

describe("GET /link-token", () => {
  const linkCalls = (s: Stack = stack) => s.upstream.plaid.calls("/link/token/create");

  test("creates a link token for a new connection, in production with the production secret", async () => {
    const before = linkCalls().length;
    const result = await admin.get<string>("/link-token");
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: "success", body: expect.stringMatching(LINK_TOKEN("production")) });
    expect(linkCalls().slice(before)).toEqual([
      { host: PLAID_PRODUCTION_HOST, path: "/link/token/create", body: linkRequest(adminId), headers: expect.objectContaining(PLAID_HEADERS) },
    ]);
    expect(stack.upstream.plaid.linkTokens.at(-1)?.link_token).toBe(result.body);
    // An empty item id is no item id.
    expect((await admin.get<string>("/link-token?item_id=")).json.status).toBe("success");
    expect(linkCalls().at(-1)?.body).toEqual(linkRequest(adminId));
  });

  test("refuses an item id given twice, asking no one", async () => {
    const before = linkCalls().length;
    for (const query of ["?item_id=a&item_id=b", "?item_id=&item_id="]) {
      expect((await admin.get(`/link-token${query}`)).json).toEqual(failed("Parameter item_id must be a single value, not an array"));
    }
    expect(linkCalls()).toHaveLength(before);
  });

  test("puts the caller's Plaid item in update mode with its stored credential", async () => {
    const { item_id, access_token } = await plaidItem(stack, adminId, "link-own");
    const before = linkCalls().length;
    const result = await admin.get<string>(`/link-token?item_id=${item_id}`);
    expect(result.json).toEqual({ status: "success", body: expect.stringMatching(LINK_TOKEN("production")) });
    expect(linkCalls().slice(before).map((call) => call.body)).toEqual([linkRequest(adminId, access_token)]);
  });

  test("puts a sharing-group member's item in update mode for the caller", async () => {
    const { item_id, access_token } = await plaidItem(stack, partnerId, "link-partner");
    const before = linkCalls().length;
    expect((await admin.get<string>(`/link-token?item_id=${item_id}`)).json.status).toBe("success");
    expect(linkCalls().slice(before).map((call) => call.body)).toEqual([linkRequest(adminId, access_token)]);
    // And the member does the same for the caller's.
    const own = await plaidItem(stack, adminId, "link-own-for-partner");
    expect((await partner.get<string>(`/link-token?item_id=${own.item_id}`)).json.status).toBe("success");
    expect(linkCalls().at(-1)?.body).toEqual(linkRequest(partnerId, own.access_token));
  });

  test("answers Item not found for a stranger's, a missing or a deleted item, asking no one", async () => {
    const strangers = await plaidItem(stack, strangerId, "link-stranger");
    const deleted = await plaidItem(stack, adminId, "link-deleted", { is_deleted: true });
    const before = linkCalls().length;
    for (const item_id of [strangers.item_id, "link-no-such-item", deleted.item_id]) {
      expect((await admin.get(`/link-token?item_id=${item_id}`)).json).toEqual(failed("Item not found."));
    }
    const own = await plaidItem(stack, adminId, "link-own-vs-stranger");
    expect((await stranger.get(`/link-token?item_id=${own.item_id}`)).json).toEqual(failed("Item not found."));
    expect(linkCalls()).toHaveLength(before);
  });

  test("makes a new link for a manual item, which has no credential", async () => {
    const item_id = await seedItem(stack, adminId, "manual", { item_id: "link-manual" });
    const before = linkCalls().length;
    expect((await admin.get<string>(`/link-token?item_id=${item_id}`)).json.status).toBe("success");
    expect(linkCalls().slice(before).map((call) => call.body)).toEqual([linkRequest(adminId)]);
  });

  test("fails as a server error when Plaid refuses, as it does a SimpleFin item's access URL", async () => {
    const item_id = await seedItem(stack, adminId, "simple_fin", { item_id: "link-simplefin" });
    const route = "GET /link-token";
    expect(alarmsFor(stack, route)).toHaveLength(0);
    const before = linkCalls().length;
    const result = await admin.get(`/link-token?item_id=${item_id}`);
    expect(result.status).toBe(500);
    expect(result.json).toEqual(SERVER_ERROR);
    expect(linkCalls().slice(before).map((call) => call.body)).toEqual([
      linkRequest(adminId, "https://user:secret@bridge.simplefin.test/simplefin"),
    ]);
    await stack.waitFor(() => alarmsFor(stack, route).length > 0, { what: "the link-token alarm" });
    expect(alarmsFor(stack, route)[0].description).toBe("**Error:** Request failed with status code 400");
    await stack.waitForLog('Route handler error {"method":"GET","path":"/link-token"}');
  });

  test("fails as a server error on any Plaid failure, and when Plaid answers nothing", async () => {
    const { item_id } = await plaidItem(stack, adminId, "link-failing");
    const scripts: [string, () => () => void][] = [
      ["login required", () => stack.upstream.plaid.fail("/link/token/create", { error_code: "ITEM_LOGIN_REQUIRED" }, { times: 1 })],
      ["Plaid down", () => stack.upstream.plaid.fail("/link/token/create", { error_code: "INTERNAL_SERVER_ERROR" }, { times: 1 })],
      ["a gateway page", () => stack.upstream.plaid.fail("/link/token/create", { status: 502, body: "<html>Bad Gateway</html>", contentType: "text/html" }, { times: 1 })],
      ["an empty answer", () => stack.upstream.plaid.fail("/link/token/create", { status: 200, body: "" }, { times: 1 })],
    ];
    for (const [what, script] of scripts) {
      script();
      const result = await admin.get(`/link-token?item_id=${item_id}`);
      expect([what, result.status, result.json]).toEqual([what, 500, SERVER_ERROR]);
    }
    await stack.waitForLog("Server failed to get link token.");
  });

  test("answers success with no token when Plaid's answer carries none", async () => {
    stack.upstream.plaid.fail("/link/token/create", { status: 200, body: '{"request_id":"r"}', contentType: "application/json" }, { times: 1 });
    expect((await admin.get("/link-token")).json).toEqual(SUCCESS);
    stack.upstream.plaid.fail("/link/token/create", { status: 200, body: "not json" }, { times: 1 });
    expect((await admin.get("/link-token")).json).toEqual(SUCCESS);
  });

  test("goes to the sandbox, with the sandbox secret, for the demo user", async () => {
    const demo = await stack.login("demo");
    const demoId = await stack.userId("demo");
    const before = linkCalls().length;
    const result = await demo.get<string>("/link-token");
    expect(result.json).toEqual({ status: "success", body: expect.stringMatching(LINK_TOKEN("sandbox")) });
    expect(linkCalls().slice(before)).toEqual([
      {
        host: PLAID_SANDBOX_HOST,
        path: "/link/token/create",
        body: linkRequest(demoId),
        headers: expect.objectContaining({ ...PLAID_HEADERS, "plaid-secret": "conformance-plaid-sandbox" }),
      },
    ]);
    // A demo item lives in the sandbox.
    const access_token = "access-sandbox-demo-item";
    await seedItem(stack, demoId, "plaid", { item_id: "link-demo-item", access_token });
    stack.upstream.plaid.addItem({ item_id: "link-demo-item", access_token, host: PLAID_SANDBOX_HOST });
    expect((await demo.get("/link-token?item_id=link-demo-item")).json.status).toBe("success");
    expect(linkCalls().at(-1)).toMatchObject({ host: PLAID_SANDBOX_HOST, body: linkRequest(demoId, access_token) });
  });
});

/** A connection with two accounts, each with one of everything an account holds, and a transfer to an account outside it. */
const seedConnection = async (s: Stack, user_id: string, item_id: string, outside_account_id: string) => {
  const accounts = [await seedAccount(s, user_id, item_id, { account_id: `${item_id}-a` }), await seedAccount(s, user_id, item_id, { account_id: `${item_id}-b` })];
  const ids = { accounts, transactions: [] as string[], splits: [] as string[], investments: [] as string[], pairs: [] as string[], snapshots: [] as string[], holdings: [] as string[] };
  const outsideTx = await seedTransaction(s, user_id, outside_account_id, { transaction_id: `${item_id}-outside-tx` });
  for (const account_id of accounts) {
    const tx = await seedTransaction(s, user_id, account_id, { transaction_id: `${account_id}-tx` });
    ids.transactions.push(tx);
    ids.splits.push(await seedSplitTransaction(s, user_id, tx, account_id));
    ids.investments.push(await seedInvestmentTransaction(s, user_id, account_id, { investment_transaction_id: `${account_id}-inv` }));
    ids.snapshots.push(await seedAccountSnapshot(s, user_id, account_id, { snapshot_id: `${account_id}-snap` }));
    await seedSecurity(s, `${account_id}-sec`);
    ids.snapshots.push(await seedHoldingSnapshot(s, user_id, account_id, `${account_id}-sec`, { snapshot_id: `${account_id}-hsnap` }));
    ids.holdings.push(await seedHolding(s, user_id, account_id, `${account_id}-sec`));
  }
  ids.pairs.push(await seedTransactionPair(s, user_id, ids.transactions[0], outsideTx));
  ids.pairs.push(await seedTransactionPair(s, user_id, ids.transactions[0], ids.transactions[1], { status: "suggested" }));
  return { item_id, outsideTx, ...ids };
};

type Connection = Awaited<ReturnType<typeof seedConnection>>;

const flagsOf = async (s: Stack, c: Connection) => ({
  items: await deletedFlags(s, "items", [c.item_id]),
  accounts: await deletedFlags(s, "accounts", c.accounts),
  transactions: await deletedFlags(s, "transactions", c.transactions),
  split_transactions: await deletedFlags(s, "split_transactions", c.splits),
  investment_transactions: await deletedFlags(s, "investment_transactions", c.investments),
  transaction_pairs: await deletedFlags(s, "transaction_pairs", c.pairs),
  snapshots: await deletedFlags(s, "snapshots", c.snapshots),
  holdings: await deletedFlags(s, "holdings", c.holdings),
  outside: await deletedFlags(s, "transactions", [c.outsideTx]),
});

const allFlags = (c: Connection, deleted: boolean) => {
  const of = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, deleted]));
  return {
    items: of([c.item_id]),
    accounts: of(c.accounts),
    transactions: of(c.transactions),
    split_transactions: of(c.splits),
    investment_transactions: of(c.investments),
    transaction_pairs: of(c.pairs),
    snapshots: of(c.snapshots),
    holdings: of(c.holdings),
    // The transaction on the other side of a transfer stays; only the pair goes.
    outside: { [c.outsideTx]: false },
  };
};

describe("DELETE /item", () => {
  const removals = (s: Stack = stack) => s.upstream.plaid.calls("/item/remove");
  const remove = (query: string, client: ApiClient = admin) => client.delete(`/item${query}`);
  let outsideItem: string;
  let outsideAccount: string;
  let partnerOutsideAccount: string;
  beforeAll(async () => {
    outsideItem = await seedItem(stack, adminId, "manual", { item_id: "del-outside-item" });
    outsideAccount = await seedAccount(stack, adminId, outsideItem, { account_id: "del-outside-account" });
    const partnerOutsideItem = await seedItem(stack, partnerId, "manual", { item_id: "del-partner-outside-item" });
    partnerOutsideAccount = await seedAccount(stack, partnerId, partnerOutsideItem, { account_id: "del-partner-outside-account" });
  });

  test("needs one id", async () => {
    const before = await rowsOf(stack, "items");
    for (const [query, message] of [
      ["", "Missing required parameter: id"],
      ["?item_id=x", "Missing required parameter: id"],
      ["?id=a&id=b", "Parameter id must be a single value, not an array"],
      ["?id=", "Parameter id cannot be empty"],
      ["?id=%20", "Parameter id cannot be empty"],
    ]) {
      const result = await remove(query);
      expect([query, result.status, result.json]).toEqual([query, 200, failed(message)]);
    }
    expect(await rowsOf(stack, "items")).toEqual(before);
  });

  test("removes the caller's Plaid item at Plaid, then deletes it with everything under it", async () => {
    const { item_id, access_token } = await plaidItem(stack, adminId, "del-plaid");
    const connection = await seedConnection(stack, adminId, item_id, outsideAccount);
    const before = removals().length;
    const result = await remove(`?id=${item_id}`);
    expect(result.status).toBe(200);
    expect(result.json).toEqual(SUCCESS);
    expect(removals().slice(before)).toEqual([
      { host: PLAID_PRODUCTION_HOST, path: "/item/remove", body: { access_token }, headers: expect.objectContaining(PLAID_HEADERS) },
    ]);
    expect(stack.upstream.plaid.items.has(access_token)).toBe(false);
    expect(await flagsOf(stack, connection)).toEqual(allFlags(connection, true));
    expect(await deletedFlags(stack, "accounts", [outsideAccount])).toEqual({ [outsideAccount]: false });
    // It is gone: a second delete finds nothing to delete.
    expect((await remove(`?id=${item_id}`)).json).toEqual(failed("Specified item is not owned by the request user"));
    expect(removals()).toHaveLength(before + 1);
  });

  test("keeps the item, and everything under it, when Plaid fails to remove it", async () => {
    const route = "DELETE /item";
    expect(alarmsFor(stack, route)).toHaveLength(0);
    const { item_id, access_token } = await plaidItem(stack, adminId, "del-plaid-failing");
    const connection = await seedConnection(stack, adminId, item_id, outsideAccount);
    stack.upstream.plaid.fail("/item/remove", { error_code: "INTERNAL_SERVER_ERROR" }, { times: 1 });
    const result = await remove(`?id=${item_id}`);
    expect(result.status).toBe(500);
    expect(result.json).toEqual(SERVER_ERROR);
    await stack.waitFor(() => alarmsFor(stack, route).length > 0, { what: "the delete-item alarm" });
    expect(alarmsFor(stack, route)[0].description).toBe("**Error:** Request failed with status code 500");
    expect(stack.upstream.plaid.items.has(access_token)).toBe(true);
    expect(await flagsOf(stack, connection)).toEqual(allFlags(connection, false));

    // An item Plaid no longer knows fails the same way.
    stack.upstream.plaid.items.delete(access_token);
    const unknown = await remove(`?id=${item_id}`);
    expect(unknown.status).toBe(500);
    expect(removals().at(-1)?.body).toEqual({ access_token });
    expect(await flagsOf(stack, connection)).toEqual(allFlags(connection, false));
  });

  test("deletes a SimpleFin or a manual item with everything under it, asking Plaid nothing", async () => {
    for (const provider of ["simple_fin", "manual"] as const) {
      const item_id = await seedItem(stack, adminId, provider, { item_id: `del-${provider}` });
      const connection = await seedConnection(stack, adminId, item_id, outsideAccount);
      const before = stack.upstream.plaid.seen().length;
      expect((await remove(`?id=${item_id}`)).json).toEqual(SUCCESS);
      expect(stack.upstream.plaid.seen()).toHaveLength(before);
      expect(await flagsOf(stack, connection)).toEqual(allFlags(connection, true));
    }
    // An item with no accounts is deleted all the same.
    const empty = await seedItem(stack, adminId, "manual", { item_id: "del-empty" });
    expect((await remove(`?id=${empty}`)).json).toEqual(SUCCESS);
    expect(await deletedFlags(stack, "items", [empty])).toEqual({ [empty]: true });
  });

  test("deletes a sharing-group member's Plaid item, removing it at Plaid for the caller", async () => {
    const { item_id, access_token } = await plaidItem(stack, partnerId, "del-partner-plaid");
    const connection = await seedConnection(stack, partnerId, item_id, partnerOutsideAccount);
    const before = removals().length;
    expect((await remove(`?id=${item_id}`)).json).toEqual(SUCCESS);
    expect(removals().slice(before)).toEqual([
      { host: PLAID_PRODUCTION_HOST, path: "/item/remove", body: { access_token }, headers: expect.objectContaining(PLAID_HEADERS) },
    ]);
    expect(await flagsOf(stack, connection)).toEqual(allFlags(connection, true));
  });

  test("refuses a stranger's, a missing or a deleted item, deleting and removing nothing", async () => {
    const strangerOutsideItem = await seedItem(stack, strangerId, "manual", { item_id: "del-stranger-outside" });
    const strangerOutside = await seedAccount(stack, strangerId, strangerOutsideItem, { account_id: "del-stranger-outside-account" });
    const strangers = await plaidItem(stack, strangerId, "del-stranger-plaid");
    const connection = await seedConnection(stack, strangerId, strangers.item_id, strangerOutside);
    const deleted = await plaidItem(stack, adminId, "del-already-deleted", { is_deleted: true });
    const before = removals().length;
    for (const [client, item_id] of [
      [admin, strangers.item_id],
      [partner, strangers.item_id],
      [admin, "del-no-such-item"],
      [admin, deleted.item_id],
    ] as const) {
      expect((await remove(`?id=${item_id}`, client)).json).toEqual(failed("Specified item is not owned by the request user"));
    }
    const own = await plaidItem(stack, adminId, "del-own-vs-stranger");
    expect((await remove(`?id=${own.item_id}`, stranger)).json).toEqual(failed("Specified item is not owned by the request user"));
    expect(removals()).toHaveLength(before);
    expect(await flagsOf(stack, connection)).toEqual(allFlags(connection, false));
    expect(await deletedFlags(stack, "items", [own.item_id])).toEqual({ [own.item_id]: false });
  });

  test("removes the demo user's item in the sandbox", async () => {
    const demo = await stack.login("demo");
    const demoId = await stack.userId("demo");
    const access_token = "access-sandbox-del-demo";
    await seedItem(stack, demoId, "plaid", { item_id: "del-demo", access_token });
    stack.upstream.plaid.addItem({ item_id: "del-demo", access_token, host: PLAID_SANDBOX_HOST });
    expect((await remove("?id=del-demo", demo)).json).toEqual(SUCCESS);
    expect(removals().at(-1)).toMatchObject({ host: PLAID_SANDBOX_HOST, body: { access_token }, headers: { "plaid-secret": "conformance-plaid-sandbox" } });
    expect(await deletedFlags(stack, "items", ["del-demo"])).toEqual({ "del-demo": true });
  });
});

describe("with a development secret and no production one", () => {
  let dev: Stack;
  beforeAll(async () => {
    dev = await startStack({ env: { PLAID_SECRET_PRODUCTION: undefined } });
  });
  afterAll(() => dev.stop());

  test("Plaid is called in production with the development secret", async () => {
    const client = await dev.login();
    const user_id = await dev.userId("admin");
    expect((await client.get<string>("/link-token")).json).toEqual({ status: "success", body: expect.stringMatching(LINK_TOKEN("production")) });
    const { item_id, access_token } = await plaidItem(dev, user_id, "dev-item");
    expect((await client.delete(`/item?id=${item_id}`)).json).toEqual(SUCCESS);
    expect(dev.upstream.plaid.seen().map((r) => [r.host, r.path, r.headers["plaid-secret"]])).toEqual([
      [PLAID_PRODUCTION_HOST, "/link/token/create", "conformance-plaid-development"],
      [PLAID_PRODUCTION_HOST, "/item/remove", "conformance-plaid-development"],
    ]);
    expect(dev.upstream.plaid.calls("/item/remove")[0].body).toEqual({ access_token });
  });
});

describe("without Plaid configured", () => {
  let bare: Stack;
  beforeAll(async () => {
    bare = await startStack({ env: { PLAID_CLIENT_ID: undefined } });
  });
  afterAll(() => bare.stop());

  test("no link token can be made, though an item is looked up first", async () => {
    const client = await bare.login();
    const user_id = await bare.userId("admin");
    const item_id = await seedItem(bare, user_id, "plaid", { item_id: "bare-link-item" });
    expect((await client.get("/link-token")).json).toEqual(failed("Plaid integration is not configured on this server."));
    expect((await client.get(`/link-token?item_id=${item_id}`)).json).toEqual(failed("Plaid integration is not configured on this server."));
    expect((await client.get("/link-token?item_id=bare-no-such-item")).json).toEqual(failed("Item not found."));
    expect(bare.upstream.plaid.seen()).toEqual([]);
  });

  test("a Plaid item is deleted here without asking Plaid", async () => {
    const client = await bare.login();
    const user_id = await bare.userId("admin");
    const outsideItem = await seedItem(bare, user_id, "manual", { item_id: "bare-outside" });
    const outside = await seedAccount(bare, user_id, outsideItem, { account_id: "bare-outside-account" });
    const item_id = await seedItem(bare, user_id, "plaid", { item_id: "bare-plaid" });
    const connection = await seedConnection(bare, user_id, item_id, outside);
    expect((await client.delete(`/item?id=${item_id}`)).json).toEqual(SUCCESS);
    expect(await flagsOf(bare, connection)).toEqual(allFlags(connection, true));
    expect(bare.upstream.plaid.seen()).toEqual([]);
  });
});
