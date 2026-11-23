/**
 * `POST /public-token?provider=…`: connecting an item. A SimpleFin setup token
 * is claimed at the bridge for the item's access URL, a Plaid public token is
 * exchanged for the item's access token; either item is stored and synced at
 * once. A manual item, the home of manually entered accounts, is created once
 * per user. What a sync stores in detail is covered by `sync-plaid.test.ts`
 * and `sync-simple-fin.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  FakeSimpleFin,
  PLAID_PRODUCTION_HOST,
  PLAID_SANDBOX_HOST,
  SIMPLEFIN_CLAIM_HOST,
  createUserClient,
  plaidAccount,
  plaidTransaction,
  simpleFinAccount,
  simpleFinHolding,
  simpleFinTransaction,
  startStack,
  type ApiClient,
  type Stack,
} from "../harness";
import { rowOf, rowsOf, seedItem, shareData } from "../harness/seed/accounts";
import { openEventStream, type EventStream } from "../harness/sse";

// One test starts a server of its own: give each the suite's 30 seconds.
setDefaultTimeout(30_000);

let stack: Stack;
let admin: ApiClient;
let adminId: string;
let partner: ApiClient;
let partnerId: string;
beforeAll(async () => {
  stack = await startStack();
  admin = await stack.login();
  adminId = await stack.userId("admin");
  ({ client: partner, user: { user_id: partnerId } } = await createUserClient(stack, "token-partner"));
  await shareData(stack, adminId, partnerId);
});
afterAll(() => stack.stop());

const streams: EventStream[] = [];
afterEach(async () => {
  for (const stream of streams.splice(0)) await stream.close();
});

const failed = (message: string) => ({ status: "failed", message });
const SERVER_ERROR = { status: "error", message: "Internal server error" };
const WRONG_TOKEN = failed("Request body has wrong type of public_token");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const pad = (n: number) => String(n).padStart(2, "0");
const localToday = () => {
  const date = new Date();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const connect = (client: ApiClient, provider: string, body?: unknown, options: Parameters<ApiClient["post"]>[2] = {}) =>
  client.post("/public-token", body, { query: { provider }, ...options });

const itemsOf = (user_id: string, provider: string) => rowsOf(stack, "items", { user_id, provider });

const routeAlarms = (s: Stack = stack) =>
  s.upstream.discord.alarms().filter((alarm) => alarm.title === "🚨 Budget Server Error: Route Error: POST /public-token");

describe("the caller and the provider", () => {
  test("an anonymous caller is refused", async () => {
    const result = await stack.anonymous().post("/public-token?provider=manual", {});
    expect(result.status).toBe(401);
    expect(result.json).toEqual(failed("Not authenticated."));
  });

  test("the provider must be named once, and be one the server knows", async () => {
    const before = stack.upstream.hub.requests.length;
    for (const [query, message] of [
      ["", "Missing required parameter: provider"],
      ["?provider=", "Parameter provider cannot be empty"],
      ["?provider=%20%20", "Parameter provider cannot be empty"],
      ["?provider=plaid&provider=plaid", "Parameter provider must be a single value, not an array"],
      ["?provider=carrier_pigeon", "Request has wrong type of provider"],
      ["?provider=PLAID", "Request has wrong type of provider"],
      ["?provider=%20plaid", "Request has wrong type of provider"],
    ]) {
      const result = await admin.post(`/public-token${query}`, { public_token: "t", institution_id: "ins_1" });
      expect([query, result.status, result.json]).toEqual([query, 200, failed(message)]);
    }
    expect(stack.upstream.hub.requests).toHaveLength(before);
  });
});

describe("provider=simple_fin", () => {
  test("refuses a body without a text public_token, asking the bridge nothing", async () => {
    const before = stack.upstream.simplefin.seen().length;
    for (const body of [undefined, null, "token", 42, [], ["token"], {}, { public_token: 42 }, { public_token: null }, { public_token: {} }]) {
      const result = await connect(admin, "simple_fin", body);
      expect([body, result.json]).toEqual([body, WRONG_TOKEN]);
    }
    // A body that is not JSON, or does not parse, reads as none.
    for (const [rawBody, contentType] of [
      ['{"public_token":"t"}', "text/plain"],
      ["{not json", "application/json"],
    ]) {
      const result = await admin.post("/public-token?provider=simple_fin", undefined, { rawBody, headers: { "Content-Type": contentType } });
      expect([rawBody, result.json]).toEqual([rawBody, WRONG_TOKEN]);
    }
    expect(stack.upstream.simplefin.seen()).toHaveLength(before);
    expect(await itemsOf(adminId, "simple_fin")).toEqual([]);
  });

  test("claims the access URL, stores the item, syncs its accounts and answers the item without its credential", async () => {
    const connection = stack.upstream.simplefin.addConnection({
      username: "token-user",
      password: "token-secret",
      accounts: [
        simpleFinAccount({
          id: "token-checking",
          name: "Token Checking",
          transactions: [simpleFinTransaction({ id: "token-tx-1", amount: "-20.00", description: "Groceries", memo: "weekly" })],
        }),
        simpleFinAccount({ id: "token-brokerage", name: "Token Brokerage", balance: "1500.00", holdings: [simpleFinHolding({ id: "token-holding" })] }),
      ],
    });
    const setupToken = stack.upstream.simplefin.setupToken(connection);
    const owner = await tabOf(admin);
    const partnerTab = await tabOf(partner);

    const result = await connect(admin, "simple_fin", { public_token: setupToken }, { headers: { "X-Tab-Id": "connecting-tab" } });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      status: "success",
      body: {
        item: {
          item_id: expect.stringMatching(UUID),
          status: "ok",
          provider: "simple_fin",
          institution_id: null,
          available_products: [],
        },
      },
    });
    const { item_id } = (result.body as { item: { item_id: string } }).item;

    // The claim, then the accounts under the claimed credentials, two weeks back.
    const calls = stack.upstream.simplefin.seen().slice(-2);
    expect(calls.map((call) => [call.host, call.method, call.path])).toEqual([
      [SIMPLEFIN_CLAIM_HOST, "POST", expect.stringMatching(/^\/claim\//)],
      ["bridge.simplefin.test", "GET", "/simplefin/accounts"],
    ]);
    expect(calls[1].headers.authorization).toBe(`Basic ${Buffer.from("token-user:token-secret").toString("base64")}`);
    const start = Number(calls[1].query["start-date"]);
    const end = Number(calls[1].query["end-date"]);
    expect(end - start).toBeGreaterThanOrEqual(13 * 86_400);
    expect(end - start).toBeLessThanOrEqual(15 * 86_400);
    expect(calls[1].query.pending).toBe("1");

    expect(await rowOf(stack, "items", item_id)).toMatchObject({
      user_id: adminId,
      provider: "simple_fin",
      access_token: connection.accessUrl,
      status: "ok",
      institution_id: null,
      available_products: [],
      is_deleted: false,
    });
    expect((await rowsOf(stack, "accounts", { item_id })).map((a) => [a.account_id, a.type])).toEqual([
      ["token-brokerage", "investment"],
      ["token-checking", "other"],
    ]);
    expect(await rowOf(stack, "transactions", "token-tx-1")).toMatchObject({ account_id: "token-checking", amount: -20, name: "Groceries" });
    expect(await rowOf(stack, "holdings", "token-holding")).toMatchObject({ account_id: "token-brokerage", quantity: 10 });
    expect(await rowOf(stack, "institutions", "org-fake-bank")).toMatchObject({ name: "Fake Bank" });

    // A connection is an accounts write, heard by the whole sharing group.
    for (const t of [owner, partnerTab]) {
      expect(await t.nextEvent()).toEqual({ id: expect.stringMatching(/^\d+$/), event: "accounts-updated", data: { originTabId: "connecting-tab" } });
    }
  });

  test("a setup token the bridge won't honour, or that points somewhere it must not, fails the request and stores nothing", async () => {
    const connection = stack.upstream.simplefin.addConnection();
    const claimed = stack.upstream.simplefin.setupToken(connection);
    expect((await connect(admin, "simple_fin", { public_token: claimed })).status).toBe(200);
    const items = (await itemsOf(adminId, "simple_fin")).length;
    const claims = stack.upstream.simplefin.seen("/claim").length;

    const tokens: [string, string, boolean][] = [
      // Claimed already: the bridge answers 403.
      ["claimed twice", claimed, true],
      ["not a URL", FakeSimpleFin.setupTokenFor("not a url"), false],
      ["plain HTTP", FakeSimpleFin.setupTokenFor(`http://${SIMPLEFIN_CLAIM_HOST}/claim/x`), false],
      ["private address", FakeSimpleFin.setupTokenFor("https://169.254.169.254/latest/meta-data"), false],
      ["localhost", FakeSimpleFin.setupTokenFor("https://localhost/claim/x"), false],
    ];
    for (const [name, public_token, asksTheBridge] of tokens) {
      const before = stack.upstream.simplefin.seen("/claim").length;
      const result = await connect(admin, "simple_fin", { public_token });
      expect([name, result.status, result.json]).toEqual([name, 500, SERVER_ERROR]);
      expect([name, stack.upstream.simplefin.seen("/claim").length - before]).toEqual([name, asksTheBridge ? 1 : 0]);
    }
    expect(stack.upstream.simplefin.seen("/claim")).toHaveLength(claims + 1);
    expect(await itemsOf(adminId, "simple_fin")).toHaveLength(items);

    // The first failure is alarmed; the rest fall in its cooldown.
    await stack.waitFor(() => routeAlarms().length > 0, { what: "the route alarm" });
    expect(routeAlarms()[0].description).toBe("**Error:** SimpleFin token exchange failed: 403 Forbidden");
  });

  test("a claim that redirects, or answers an access URL outside the allowlist, fails the request and stores nothing", async () => {
    const items = (await itemsOf(adminId, "simple_fin")).length;
    for (const failure of [
      { redirect: "https://169.254.169.254/latest" },
      { status: 200, body: "http://user:pw@bridge.simplefin.test/simplefin", contentType: "text/plain" },
      { status: 200, body: "https://user:pw@10.0.0.1/simplefin", contentType: "text/plain" },
    ]) {
      const connection = stack.upstream.simplefin.addConnection();
      const remove = stack.upstream.simplefin.fail("/claim", failure, { times: 1 });
      try {
        const result = await connect(admin, "simple_fin", { public_token: stack.upstream.simplefin.setupToken(connection) });
        expect([failure, result.status, result.json]).toEqual([failure, 500, SERVER_ERROR]);
      } finally {
        remove();
      }
    }
    expect(await itemsOf(adminId, "simple_fin")).toHaveLength(items);
  });

  test("a sync that fails after the claim fails the request, and the item stays stored", async () => {
    const connection = stack.upstream.simplefin.addConnection({ username: "token-sync-fails" });
    stack.upstream.simplefin.fail("/simplefin/accounts", { status: 500 }, { times: 1 });
    const before = (await itemsOf(adminId, "simple_fin")).length;
    const result = await connect(admin, "simple_fin", { public_token: stack.upstream.simplefin.setupToken(connection) });
    expect(result.status).toBe(500);
    expect(result.json).toEqual(SERVER_ERROR);
    const stored = await itemsOf(adminId, "simple_fin");
    expect(stored).toHaveLength(before + 1);
    expect(stored.filter((item) => item.access_token === connection.accessUrl)).toHaveLength(1);
  });
});

/** A tab of `client`, read up to its `connected` event. */
const tabOf = async (client: ApiClient): Promise<EventStream> => {
  const stream = await openEventStream(client);
  streams.push(stream);
  await stream.next((block) => block.event === "connected");
  return stream;
};

describe("provider=plaid", () => {
  test("refuses a body without a text public_token and institution_id, asking Plaid nothing", async () => {
    const before = stack.upstream.plaid.seen().length;
    for (const body of [
      undefined,
      null,
      "token",
      [],
      {},
      { public_token: "t" },
      { institution_id: "ins_1" },
      { public_token: 1, institution_id: "ins_1" },
      { public_token: "t", institution_id: 1 },
      { public_token: "t", institution_id: null },
      { public_token: null, institution_id: "ins_1" },
    ]) {
      const result = await connect(admin, "plaid", body);
      expect([body, result.json]).toEqual([body, WRONG_TOKEN]);
    }
    expect(stack.upstream.plaid.seen()).toHaveLength(before);
  });

  test("on a server without Plaid credentials, refuses a well-formed request, after the body checks", async () => {
    const unconfigured = await startStack({ env: { PLAID_SECRET_SANDBOX: undefined } });
    try {
      const client = await unconfigured.login();
      expect((await connect(client, "plaid", { public_token: 1 })).json).toEqual(WRONG_TOKEN);
      expect((await connect(client, "plaid", { public_token: "t", institution_id: "ins_1" })).json).toEqual(
        failed("Plaid integration is not configured"),
      );
      expect(unconfigured.upstream.plaid.seen()).toEqual([]);
    } finally {
      await unconfigured.stop();
    }
  });

  test("exchanges the token, reads the item's products, stores the item and syncs its accounts", async () => {
    const { public_token, item } = stack.upstream.plaid.createPublicToken({
      products: [],
      accounts: [plaidAccount({ account_id: "token-plaid-checking", name: "Token Plaid Checking" })],
    });
    const before = stack.upstream.plaid.seen().length;
    const result = await connect(admin, "plaid", { public_token, institution_id: "ins_token" });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      status: "success",
      body: { item: { item_id: item.item_id, institution_id: "ins_token", available_products: [], status: "ok", provider: "plaid" } },
    });
    // With no products, the sync asks only for the accounts.
    expect(stack.upstream.plaid.seen().slice(before).map((call) => [call.host, call.path, call.json])).toEqual([
      [PLAID_PRODUCTION_HOST, "/item/public_token/exchange", { public_token }],
      [PLAID_PRODUCTION_HOST, "/item/get", { access_token: item.access_token }],
      [PLAID_PRODUCTION_HOST, "/accounts/get", { access_token: item.access_token }],
    ]);
    expect(await rowOf(stack, "items", item.item_id)).toMatchObject({
      user_id: adminId,
      provider: "plaid",
      access_token: item.access_token,
      institution_id: "ins_token",
      available_products: [],
      status: "ok",
    });
    expect(await rowOf(stack, "accounts", "token-plaid-checking")).toMatchObject({
      item_id: item.item_id,
      institution_id: "ins_token",
      name: "Token Plaid Checking",
      balances_current: 110,
    });
  });

  test("with the Transactions and Investments products, syncs the accounts, holdings and both kinds of transactions", async () => {
    const { public_token, item } = stack.upstream.plaid.createPublicToken({
      products: ["transactions", "investments"],
      accounts: [
        plaidAccount({ account_id: "token-both-checking" }),
        plaidAccount({ account_id: "token-both-brokerage", type: "investment", subtype: "brokerage" }),
      ],
      syncPages: [{ added: [plaidTransaction({ transaction_id: "token-both-tx", account_id: "token-both-checking" })] }],
    });
    const before = stack.upstream.plaid.seen().length;
    // The Bun server syncs the accounts and the transactions at once, and which reaches Plaid first
    // there depends on which of its database reads answers first.
    const result = await stack.upstream.hub.unordered(() => connect(admin, "plaid", { public_token, institution_id: "ins_both" }));
    expect(result.json).toEqual({
      status: "success",
      body: {
        item: { item_id: item.item_id, institution_id: "ins_both", available_products: ["transactions", "investments"], status: "ok", provider: "plaid" },
      },
    });
    expect(stack.upstream.plaid.seen().slice(before).map((call) => call.path).sort()).toEqual([
      "/accounts/get",
      "/investments/holdings/get",
      "/investments/transactions/get",
      "/item/get",
      "/item/public_token/exchange",
      "/transactions/sync",
    ]);
    expect(await rowOf(stack, "transactions", "token-both-tx")).toMatchObject({ account_id: "token-both-checking", user_id: adminId });
    expect(await rowOf(stack, "items", item.item_id)).toMatchObject({ cursor: "cursor-1" });
    expect((await rowsOf(stack, "accounts", { item_id: item.item_id })).map((a) => a.account_id)).toEqual([
      "token-both-brokerage",
      "token-both-checking",
    ]);
  });

  test("drops the Investments product when Plaid doesn't support its holdings or investment transactions for the item", async () => {
    const { public_token, item } = stack.upstream.plaid.createPublicToken({
      products: ["transactions", "investments"],
      accounts: [plaidAccount({ account_id: "token-unsupported-checking" })],
    });
    for (const endpoint of ["/investments/holdings/get", "/investments/transactions/get"]) {
      stack.upstream.plaid.fail(endpoint, { error_code: "PRODUCTS_NOT_SUPPORTED" }, { accessToken: item.access_token });
    }
    const before = stack.upstream.plaid.seen().length;
    // The two syncs reach Plaid in no fixed order on the Bun server (see above). Both read the item
    // before either drops the product, so both ask for investments.
    const result = await stack.upstream.hub.unordered(() => connect(admin, "plaid", { public_token, institution_id: "ins_unsupported" }));
    expect(result.json).toMatchObject({ status: "success", body: { item: { available_products: ["transactions", "investments"] } } });
    expect(stack.upstream.plaid.seen().slice(before).map((call) => call.path).sort()).toEqual([
      "/accounts/get",
      "/investments/holdings/get",
      "/investments/transactions/get",
      "/item/get",
      "/item/public_token/exchange",
      "/transactions/sync",
    ]);
    await stack.waitFor(async () => String((await rowOf(stack, "items", item.item_id))?.available_products) === "transactions", {
      what: "the product dropped",
    });
    await stack.waitForLog(`Holdings not supported for item, removing Investments from available_products {"itemId":"${item.item_id}"}`);
    await stack.waitForLog(`Investment transactions not supported for item, removing Investments from available_products {"itemId":"${item.item_id}"}`);
    expect(await rowOf(stack, "accounts", "token-unsupported-checking")).toMatchObject({ item_id: item.item_id });
  });

  test("the demo user's token is exchanged in the sandbox, its products read in production", async () => {
    const demo = await stack.login("demo");
    const demoId = await stack.userId("demo");
    const { public_token, item } = stack.upstream.plaid.createPublicToken({ products: [], accounts: [] });
    const before = stack.upstream.plaid.seen().length;
    const result = await connect(demo, "plaid", { public_token, institution_id: "ins_demo" });
    expect(result.json).toMatchObject({ status: "success" });
    expect(stack.upstream.plaid.seen().slice(before).map((call) => [call.host, call.path])).toEqual([
      [PLAID_SANDBOX_HOST, "/item/public_token/exchange"],
      [PLAID_PRODUCTION_HOST, "/item/get"],
      [PLAID_SANDBOX_HOST, "/accounts/get"],
    ]);
    expect(await rowOf(stack, "items", item.item_id)).toMatchObject({ user_id: demoId });
  });

  test("a token Plaid refuses, or an item Plaid won't describe, fails the request and stores nothing", async () => {
    const before = (await itemsOf(adminId, "plaid")).length;
    const unknown = await connect(admin, "plaid", { public_token: "public-production-unknown", institution_id: "ins_1" });
    expect(unknown.status).toBe(500);
    expect(unknown.json).toEqual(SERVER_ERROR);

    const { public_token, item } = stack.upstream.plaid.createPublicToken({ products: [] });
    stack.upstream.plaid.fail("/item/get", { error_code: "ITEM_LOGIN_REQUIRED" }, { times: 1 });
    const undescribed = await connect(admin, "plaid", { public_token, institution_id: "ins_1" });
    expect(undescribed.status).toBe(500);
    expect(await rowOf(stack, "items", item.item_id)).toBeUndefined();
    expect(await itemsOf(adminId, "plaid")).toHaveLength(before);
  });
});

describe("provider=manual", () => {
  test("creates the caller's manual item once, which the sharing group hears", async () => {
    const { client, user } = await createUserClient(stack, "token-manual-solo");
    const [ownTab] = [await tabOf(client)];
    // The item id is a random one of five hex digits, which the comparison can't mask.
    const result = await connect(client, "manual", {}, { headers: { "X-Tab-Id": "manual-tab" }, noCompare: true });
    expect(result.json).toEqual({
      status: "success",
      body: {
        item: {
          item_id: expect.stringMatching(/^[0-9a-f]{5}$/),
          provider: "manual",
          updated: localToday(),
          status: "ok",
          institution_id: null,
          available_products: [],
          user_id: user.user_id,
        },
      },
    });
    const { item_id } = (result.body as { item: { item_id: string } }).item;
    expect(await rowOf(stack, "items", item_id)).toMatchObject({
      user_id: user.user_id,
      provider: "manual",
      access_token: "no_access_token",
      status: "ok",
      institution_id: null,
      available_products: [],
    });
    expect(await ownTab.nextEvent()).toEqual({ id: expect.stringMatching(/^\d+$/), event: "accounts-updated", data: { originTabId: "manual-tab" } });

    // A second one is refused, whatever the body.
    for (const body of [{}, undefined, { public_token: "t" }]) {
      expect((await connect(client, "manual", body)).json).toEqual(failed("Manual item already exists for the user"));
    }
    expect(await itemsOf(user.user_id, "manual")).toHaveLength(1);
  });

  test("another member's manual item doesn't stand in for the caller's, nor does the caller's deleted one", async () => {
    await seedItem(stack, partnerId, "manual", { item_id: "token-partner-manual" });
    await seedItem(stack, adminId, "manual", { item_id: "token-admin-deleted-manual", is_deleted: true });
    const result = await connect(admin, "manual", {}, { noCompare: true });
    expect(result.json).toMatchObject({ status: "success", body: { item: { user_id: adminId, provider: "manual" } } });
    const own = (await itemsOf(adminId, "manual")).filter((item) => !item.is_deleted);
    expect(own).toHaveLength(1);
    // The caller now has one: refused for them, and the partner still has their own.
    expect((await connect(admin, "manual", {})).json).toEqual(failed("Manual item already exists for the user"));
    expect((await connect(partner, "manual", {})).json).toEqual(failed("Manual item already exists for the user"));
  });
});
