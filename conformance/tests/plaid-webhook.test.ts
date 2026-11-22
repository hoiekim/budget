/**
 * `POST /plaid-hook`: the webhook Plaid calls when an item has news. It is
 * public, so every request is checked first: Plaid signs each webhook with an
 * ES256 JWT in `Plaid-Verification`, naming the key it signed with, which the
 * server fetches from Plaid (and caches) to verify the signature and the body's
 * hash. A verified webhook then syncs the item's transactions, marks an item
 * that needs its user bad, or reads an item's products again; whatever changed
 * is announced to the open tabs of the owner's sharing group.
 *
 * What a sync stores is covered by `sync-plaid.test.ts`; here, that a sync ran.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  PLAID_PRODUCTION_HOST,
  createUserClient,
  plaidTransaction,
  startStack,
  type ApiClient,
  type ApiResult,
  type Stack,
} from "../harness";
import { rowOf, seedAccount, seedItem, shareData } from "../harness/seed/accounts";
import { openEventStream, type EventStream } from "../harness/sse";

// Tests here start extra servers: give each the suite's 30 seconds.
setDefaultTimeout(30_000);

let stack: Stack;
let adminId: string;
let partnerId: string;
let partner: ApiClient;
let outsider: ApiClient;
/** The key Plaid signs this file's webhooks with. */
let kid: string;

beforeAll(async () => {
  stack = await startStack();
  adminId = await stack.userId("admin");
  ({ client: partner, user: { user_id: partnerId } } = await createUserClient(stack, "hook-partner"));
  ({ client: outsider } = await createUserClient(stack, "hook-outsider"));
  await shareData(stack, adminId, partnerId);
  ({ kid } = stack.upstream.plaid.addWebhookKey("conformance-webhook-key"));
});
afterAll(() => stack.stop());

const streams: EventStream[] = [];
afterEach(async () => {
  for (const stream of streams.splice(0)) await stream.close();
});

const SUCCESS = { status: "success" };
const FAILED = { status: "failed" };
const failed = (message: string) => ({ status: "failed", message });
const SERVER_ERROR = { status: "error", message: "Internal server error" };
const UNAVAILABLE = failed("Webhook verification unavailable, retry later");
const INVALID = failed("Invalid webhook signature");

interface HookOptions {
  /** The `Plaid-Verification` header; signed with the file's key by default, left out when null. */
  jwt?: string | null;
  /** What is sent instead of the JSON of `body`. */
  rawBody?: string;
  contentType?: string;
  target?: Stack;
}

/** Posts a webhook, as Plaid does: the JSON of `body`, signed. */
const hook = (body: unknown, { jwt, rawBody, contentType = "application/json", target = stack }: HookOptions = {}): Promise<ApiResult> => {
  const text = rawBody ?? JSON.stringify(body);
  const signature = jwt === undefined ? target.upstream.plaid.signWebhook(text, { kid }) : jwt;
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (signature !== null) headers["Plaid-Verification"] = signature;
  return target.anonymous().request("POST", "/plaid-hook", { rawBody: text, headers });
};

const keyFetches = (s: Stack = stack) => s.upstream.plaid.calls("/webhook_verification_key/get").map((call) => call.body);

/** A Plaid item of `user_id` that the fake knows by the same access token. */
const plaidItem = async (user_id: string, item_id: string, init: Parameters<Stack["upstream"]["plaid"]["addItem"]>[0] = {}) => {
  const access_token = `access-production-${item_id}`;
  await seedItem(stack, user_id, "plaid", { item_id, access_token });
  stack.upstream.plaid.addItem({ item_id, access_token, ...init });
  return { item_id, access_token };
};

/** The logged context of the latest line containing `message`. */
const loggedContext = (message: string): Record<string, unknown> => {
  const line = [...stack.logs].reverse().find((l) => l.includes(message));
  if (!line) throw new Error(`no "${message}" line in the log`);
  return JSON.parse(line.slice(line.indexOf("{")));
};

/** An open tab of `client`, read up to its `connected` event. */
const tab = async (client: ApiClient): Promise<EventStream> => {
  const stream = await openEventStream(client);
  streams.push(stream);
  await stream.next((block) => block.event === "connected");
  return stream;
};

/** Expects each tab's next event to be `event`, from no tab in particular. */
const expectEvent = async (tabs: EventStream[], event: string) => {
  for (const t of tabs) expect(await t.nextEvent()).toEqual({ id: expect.stringMatching(/^\d+$/), event, data: {} });
};

/** Expects the tab of `client` to have heard nothing: its user's own write is the next thing it hears. */
const expectNothingHeard = async (client: ApiClient, stream: EventStream) => {
  expect((await client.get("/new-budget", { headers: { "X-Tab-Id": "quiet" } })).json.status).toBe("success");
  expect(await stream.nextEvent()).toEqual({ id: expect.stringMatching(/^\d+$/), event: "budgets-updated", data: { originTabId: "quiet" } });
};

describe("before anything is verified", () => {
  test("a server without Plaid credentials refuses every webhook, asking Plaid nothing", async () => {
    const unconfigured = await startStack({ env: { PLAID_CLIENT_ID: undefined } });
    try {
      unconfigured.upstream.plaid.addWebhookKey(kid);
      const body = { webhook_type: "ITEM", webhook_code: "WEBHOOK_UPDATE_ACKNOWLEDGED", item_id: "i" };
      const result = await hook(body, { target: unconfigured });
      expect(result.status).toBe(401);
      expect(result.json).toEqual(failed("Webhook verification failed"));
      expect(unconfigured.logCount("[Plaid Webhook] Plaid not configured — rejecting webhook")).toBe(1);
      expect(unconfigured.upstream.plaid.seen()).toEqual([]);
    } finally {
      await unconfigured.stop();
    }
  });

  test("a body that is not JSON, or is empty, cannot be checked and is refused without asking Plaid", async () => {
    const before = stack.upstream.plaid.seen().length;
    const logged = stack.logCount("[Plaid Webhook] Raw body not available for verification");
    const body = JSON.stringify({ webhook_type: "ITEM", webhook_code: "WEBHOOK_UPDATE_ACKNOWLEDGED", item_id: "i" });
    for (const [rawBody, contentType] of [
      [body, "text/plain"],
      [body, "application/x-www-form-urlencoded"],
      ["", "application/json"],
    ]) {
      const result = await hook(undefined, { rawBody, contentType });
      expect([contentType, result.status, result.json]).toEqual([contentType, 401, failed("Webhook verification failed")]);
    }
    expect(stack.logCount("[Plaid Webhook] Raw body not available for verification")).toBe(logged + 3);
    expect(stack.upstream.plaid.seen()).toHaveLength(before);
  });
});

describe("verifying the signature", () => {
  const body = { webhook_type: "ITEM", webhook_code: "WEBHOOK_UPDATE_ACKNOWLEDGED", item_id: "verified-item" };

  test("a webhook signed with Plaid's key is handled, the key fetched once from production and then cached", async () => {
    const first = await hook(body);
    expect(first.status).toBe(200);
    expect(first.json).toEqual(SUCCESS);
    expect(keyFetches()).toEqual([{ key_id: kid }]);
    expect(stack.upstream.plaid.calls("/webhook_verification_key/get")[0]).toMatchObject({
      host: PLAID_PRODUCTION_HOST,
      headers: expect.objectContaining({ "plaid-client-id": "conformance-plaid-client", "plaid-secret": "conformance-plaid-production" }),
    });
    expect((await hook(body)).json).toEqual(SUCCESS);
    expect(keyFetches()).toHaveLength(1);
  });

  test("a webhook without a signature, with a malformed one, or with one naming no key is refused as invalid", async () => {
    const before = keyFetches().length;
    const text = JSON.stringify(body);
    const unsigned = stack.upstream.plaid.signWebhook(text, { kid });
    const [header, payload] = unsigned.split(".");
    const noKid = stack.upstream.plaid.signWebhook(text, { kid, header: { kid: undefined } });
    for (const jwt of [null, "", "not-a-jwt", "a.b.c", `${header}.${payload}`, noKid]) {
      const result = await hook(body, { jwt });
      expect([jwt, result.status, result.json]).toEqual([jwt, 401, INVALID]);
    }
    expect(keyFetches()).toHaveLength(before);
    expect(stack.logs.some((line) => line.includes("Missing Plaid-Verification header"))).toBe(true);
    expect(stack.logs.some((line) => line.includes("JWT missing key_id (kid)"))).toBe(true);
  });

  test("a webhook whose body changed after signing, signed by another key, stale, or without the body's hash is invalid", async () => {
    const other = stack.upstream.plaid.addWebhookKey("conformance-other-key");
    const text = JSON.stringify(body);
    const altered = JSON.stringify({ ...body, webhook_code: "PENDING_EXPIRATION" });
    const cases: [string, string, string][] = [
      ["altered", altered, stack.upstream.plaid.signWebhook(text, { kid })],
      ["forged", text, stack.upstream.plaid.signWebhook(text, { kid: other.kid, header: { kid } })],
      ["stale", text, stack.upstream.plaid.signWebhook(text, { kid, iat: Math.floor(Date.now() / 1000) - 600 })],
      ["no hash", text, stack.upstream.plaid.signWebhook(text, { kid, claims: { request_body_sha256: undefined } })],
      ["wrong algorithm", text, stack.upstream.plaid.signWebhook(text, { kid, header: { alg: "HS256" } })],
    ];
    for (const [name, rawBody, jwt] of cases) {
      const result = await hook(undefined, { rawBody, jwt });
      expect([name, result.status, result.json]).toEqual([name, 401, INVALID]);
    }
    // Every case named the cached key: nothing more was fetched.
    expect(keyFetches()).toEqual([{ key_id: kid }]);
    expect(await rowOf(stack, "items", "verified-item")).toBeUndefined();
  });

  test("a key Plaid says does not exist makes the webhook invalid, and is remembered as unknown", async () => {
    const text = JSON.stringify(body);
    const jwt = stack.upstream.plaid.signWebhook(text, { kid, header: { kid: "conformance-no-such-key" } });
    const before = keyFetches().length;
    for (let i = 0; i < 2; i++) {
      const result = await hook(undefined, { rawBody: text, jwt });
      expect(result.status).toBe(401);
      expect(result.json).toEqual(INVALID);
    }
    expect(keyFetches().slice(before)).toEqual([{ key_id: "conformance-no-such-key" }]);
  });

  test("a key that cannot be fetched just now leaves the webhook unverifiable: a 503 Plaid retries, and the next one asks again", async () => {
    const fresh = stack.upstream.plaid.addWebhookKey("conformance-flaky-key");
    const remove = stack.upstream.plaid.fail("/webhook_verification_key/get", { error_code: "INTERNAL_SERVER_ERROR" });
    const text = JSON.stringify({ ...body, item_id: "no-such-item" });
    const jwt = stack.upstream.plaid.signWebhook(text, { kid: fresh.kid });
    const before = keyFetches().length;
    try {
      for (let i = 0; i < 2; i++) {
        const result = await hook(undefined, { rawBody: text, jwt });
        expect(result.status).toBe(503);
        expect(result.json).toEqual(UNAVAILABLE);
      }
    } finally {
      remove();
    }
    // The item the body names does not exist, so no fetch was given priority.
    expect(keyFetches().slice(before)).toEqual([{ key_id: fresh.kid }, { key_id: fresh.kid }]);
    expect(stack.logs.some((line) => line.includes("Failed to fetch verification key"))).toBe(true);
    // Once Plaid answers, the same webhook verifies.
    expect((await hook(undefined, { rawBody: text, jwt })).json).toEqual(SUCCESS);
  });

  test("an unverifiable webhook naming a real item is verified again with priority, and handled when that works", async () => {
    // Shaped like Plaid's own sample item ids: 37 mixed-case letters and digits.
    const { item_id } = await plaidItem(adminId, "M5eVJqLnv3tbzdngLDp9FL5OlDNxlNhlE55op");
    const fresh = stack.upstream.plaid.addWebhookKey("conformance-priority-key");
    stack.upstream.plaid.fail("/webhook_verification_key/get", { error_code: "INTERNAL_SERVER_ERROR" }, { times: 1 });
    const text = JSON.stringify({ webhook_type: "ITEM", webhook_code: "WEBHOOK_UPDATE_ACKNOWLEDGED", item_id });
    const before = keyFetches().length;
    const result = await hook(undefined, { rawBody: text, jwt: stack.upstream.plaid.signWebhook(text, { kid: fresh.kid }) });
    expect(result.status).toBe(200);
    expect(result.json).toEqual(SUCCESS);
    expect(keyFetches().slice(before)).toEqual([{ key_id: fresh.kid }, { key_id: fresh.kid }]);
  });
});

describe("the body of a verified webhook", () => {
  test("must be an object", async () => {
    for (const [rawBody, message] of [
      ['"not-an-object"', "Request body must be an object"],
      ["[1, 2]", "Request body must be an object"],
      ["42", "Request body must be an object"],
      ["null", "Request body is required"],
      ["{not json", "Request body is required"],
    ]) {
      const result = await hook(undefined, { rawBody });
      expect([rawBody, result.status, result.json]).toEqual([rawBody, 200, failed(message)]);
    }
  });

  test("of a type or code it does not handle is logged and answered with nothing", async () => {
    const cases: Record<string, unknown>[] = [
      { webhook_type: "TRANSACTIONS", webhook_code: "NOPE", item_id: "i" },
      { webhook_type: "ITEM", webhook_code: "MYSTERY", item_id: "i" },
      { webhook_type: "ITEM", webhook_code: "ERROR", item_id: "i", error: { error_code: "SOMETHING_ELSE" } },
      { webhook_type: "ITEM", webhook_code: "ERROR", item_id: "i" },
      { webhook_type: "ITEM", webhook_code: "ERROR", item_id: "i", error: null },
      { webhook_type: "HOLDINGS", webhook_code: "NOPE", item_id: "i" },
      { webhook_type: "INVESTMENTS_TRANSACTIONS", webhook_code: "INITIAL_UPDATE", item_id: "i" },
      { webhook_type: "AUTH", webhook_code: "DEFAULT_UPDATE", item_id: "i" },
      { webhook_type: "transactions", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "i" },
      { webhook_code: "SYNC_UPDATES_AVAILABLE" },
      {},
    ];
    for (const body of cases) {
      const before = stack.logCount("Unhandled webhook");
      const result = await hook(body);
      expect([body, result.status, result.text]).toEqual([body, 200, ""]);
      expect(stack.logCount("Unhandled webhook")).toBe(before + 1);
      const context = loggedContext("Unhandled webhook");
      const expected: Record<string, unknown> = { body };
      if (body.item_id !== undefined) expected.itemId = body.item_id;
      if (body.webhook_type !== undefined) expected.webhookType = body.webhook_type;
      if (body.webhook_code !== undefined) expected.webhookCode = body.webhook_code;
      expect(context).toEqual(expected);
    }
  });
});

describe("TRANSACTIONS, HOLDINGS and INVESTMENTS_TRANSACTIONS", () => {
  test("SYNC_UPDATES_AVAILABLE syncs the item and tells its owner's sharing group, and nobody else, when something changed", async () => {
    const account_id = "hook-sync-account";
    const { item_id, access_token } = await plaidItem(adminId, "hook-sync-item");
    await seedAccount(stack, adminId, item_id, { account_id });
    stack.upstream.plaid.addSyncPage(access_token, {
      added: [plaidTransaction({ transaction_id: "hook-sync-tx", account_id, date: "2026-03-02", authorized_date: "2026-03-01" })],
    });
    const owner = await stack.login();
    const tabs = [await tab(owner), await tab(partner)];
    const quiet = await tab(outsider);

    const result = await hook({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id });
    expect(result.json).toEqual(SUCCESS);
    expect(stack.upstream.plaid.calls("/transactions/sync").filter((c) => c.body.access_token === access_token).map((c) => c.body)).toEqual([
      { access_token },
    ]);
    expect(loggedContext("Synced transactions via webhook")).toEqual({ itemId: item_id, added: 1, modified: 0, removed: 0 });
    expect(await rowOf(stack, "transactions", "hook-sync-tx")).toMatchObject({ account_id, user_id: adminId, is_deleted: false });
    expect(await rowOf(stack, "items", item_id)).toMatchObject({ cursor: "cursor-1" });
    await expectEvent(tabs, "transactions-updated");
    await expectNothingHeard(outsider, quiet);

    // Nothing new at Plaid: synced again, nobody told.
    expect((await hook({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id })).json).toEqual(SUCCESS);
    expect(loggedContext("Synced transactions via webhook")).toEqual({ itemId: item_id, added: 0, modified: 0, removed: 0 });
    expect(stack.upstream.plaid.calls("/transactions/sync").filter((c) => c.body.access_token === access_token).map((c) => c.body)).toEqual([
      { access_token },
      { access_token, cursor: "cursor-1" },
    ]);
    // The owner's own write is the next thing either tab of the group hears.
    await expectNothingHeard(owner, tabs[0]);
    expect(await tabs[1].nextEvent()).toEqual({ id: expect.stringMatching(/^\d+$/), event: "budgets-updated", data: { originTabId: "quiet" } });
  });

  test("HOLDINGS DEFAULT_UPDATE and INVESTMENTS_TRANSACTIONS DEFAULT_UPDATE / HISTORICAL_UPDATE sync the item too", async () => {
    const account_id = "hook-holdings-account";
    const { item_id, access_token } = await plaidItem(adminId, "hook-holdings-item");
    await seedAccount(stack, adminId, item_id, { account_id });
    const owner = await stack.login();
    const ownerTab = await tab(owner);
    let n = 0;
    for (const [webhook_type, webhook_code] of [
      ["HOLDINGS", "DEFAULT_UPDATE"],
      ["INVESTMENTS_TRANSACTIONS", "DEFAULT_UPDATE"],
      ["INVESTMENTS_TRANSACTIONS", "HISTORICAL_UPDATE"],
    ]) {
      n += 1;
      stack.upstream.plaid.addSyncPage(access_token, { added: [plaidTransaction({ transaction_id: `hook-holdings-tx-${n}`, account_id })] });
      const result = await hook({ webhook_type, webhook_code, item_id });
      expect([webhook_type, webhook_code, result.json]).toEqual([webhook_type, webhook_code, SUCCESS]);
      expect(loggedContext("Synced transactions via webhook")).toEqual({ itemId: item_id, added: 1, modified: 0, removed: 0 });
      await expectEvent([ownerTab], "transactions-updated");
    }
    expect(stack.upstream.plaid.calls("/transactions/sync").filter((c) => c.body.access_token === access_token)).toHaveLength(3);
  });

  test("DEFAULT_UPDATE, INITIAL_UPDATE, HISTORICAL_UPDATE and TRANSACTIONS_REMOVED are acknowledged without a sync", async () => {
    const { item_id } = await plaidItem(adminId, "hook-ack-item");
    const before = stack.upstream.plaid.seen("/transactions").length;
    for (const webhook_code of ["DEFAULT_UPDATE", "INITIAL_UPDATE", "HISTORICAL_UPDATE", "TRANSACTIONS_REMOVED"]) {
      const result = await hook({ webhook_type: "TRANSACTIONS", webhook_code, item_id });
      expect([webhook_code, result.json]).toEqual([webhook_code, SUCCESS]);
    }
    expect(stack.upstream.plaid.seen("/transactions")).toHaveLength(before);
  });

  test("a sync of an item that does not exist, is deleted, or is not a Plaid item fails without asking Plaid", async () => {
    await seedItem(stack, adminId, "plaid", { item_id: "hook-deleted-item", is_deleted: true });
    await seedItem(stack, adminId, "simple_fin", { item_id: "hook-simplefin-item" });
    await seedItem(stack, adminId, "manual", { item_id: "hook-manual-item" });
    const before = stack.upstream.plaid.seen().length;
    for (const item_id of ["hook-no-such-item", "hook-deleted-item", "hook-simplefin-item", "hook-manual-item", undefined, null]) {
      const result = await hook({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id });
      expect([item_id, result.status, result.json]).toEqual([item_id, 200, FAILED]);
    }
    expect(stack.upstream.plaid.seen()).toHaveLength(before);
  });

  test("an item id that is a number fails in the database: a 500 and an alarm", async () => {
    const result = await hook({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: 42 });
    expect(result.status).toBe(500);
    expect(result.json).toEqual(SERVER_ERROR);
    await stack.waitFor(() => stack.upstream.discord.alarms().some((alarm) => alarm.title === "🚨 Budget Server Error: Route Error: POST /plaid-hook"), {
      what: "the route alarm",
    });
    const alarm = stack.upstream.discord.alarms().find((a) => a.title === "🚨 Budget Server Error: Route Error: POST /plaid-hook");
    expect(alarm?.description).toBe("**Error:** operator does not exist: character varying = integer");
  });
});

describe("ITEM", () => {
  test("WEBHOOK_UPDATE_ACKNOWLEDGED is acknowledged and changes nothing", async () => {
    const { item_id } = await plaidItem(adminId, "hook-ack-update-item");
    const before = await rowOf(stack, "items", item_id);
    expect((await hook({ webhook_type: "ITEM", webhook_code: "WEBHOOK_UPDATE_ACKNOWLEDGED", item_id })).json).toEqual(SUCCESS);
    expect(await rowOf(stack, "items", item_id)).toEqual(before);
  });

  test("PENDING_EXPIRATION and ERROR / ITEM_LOGIN_REQUIRED mark the item bad and tell its owner's sharing group", async () => {
    const owner = await stack.login();
    const tabs = [await tab(owner), await tab(partner)];
    const quiet = await tab(outsider);
    const cases: [string, Record<string, unknown>, string][] = [
      ["hook-expiring-item", { webhook_type: "ITEM", webhook_code: "PENDING_EXPIRATION" }, "PENDING_EXPIRATION"],
      ["hook-login-item", { webhook_type: "ITEM", webhook_code: "ERROR", error: { error_code: "ITEM_LOGIN_REQUIRED" } }, "ITEM_LOGIN_REQUIRED"],
    ];
    for (const [item_id, body, reason] of cases) {
      await plaidItem(partnerId, item_id);
      const result = await hook({ ...body, item_id });
      expect(result.json).toEqual(SUCCESS);
      expect(await rowOf(stack, "items", item_id)).toMatchObject({ status: "bad", status_reason: reason, user_id: partnerId });
      await expectEvent(tabs, "accounts-updated");
    }
    await expectNothingHeard(outsider, quiet);
  });

  test("PENDING_EXPIRATION marks any provider's item bad: it does not ask which provider the item is", async () => {
    await seedItem(stack, adminId, "simple_fin", { item_id: "hook-expiring-simplefin" });
    expect((await hook({ webhook_type: "ITEM", webhook_code: "PENDING_EXPIRATION", item_id: "hook-expiring-simplefin" })).json).toEqual(SUCCESS);
    expect(await rowOf(stack, "items", "hook-expiring-simplefin")).toMatchObject({ status: "bad", status_reason: "PENDING_EXPIRATION" });
  });

  test("marking an item that does not exist, or is deleted, fails and is logged", async () => {
    await seedItem(stack, adminId, "plaid", { item_id: "hook-deleted-bad-item", is_deleted: true, status: "ok" });
    for (const item_id of ["hook-missing-bad-item", "hook-deleted-bad-item", undefined]) {
      for (const body of [
        { webhook_type: "ITEM", webhook_code: "PENDING_EXPIRATION", item_id },
        { webhook_type: "ITEM", webhook_code: "ERROR", item_id, error: { error_code: "ITEM_LOGIN_REQUIRED" } },
      ]) {
        const before = stack.logCount("Plaid webhook status update skipped — no user for item");
        expect((await hook(body)).json).toEqual(FAILED);
        expect(stack.logCount("Plaid webhook status update skipped — no user for item")).toBe(before + 1);
        // Without an id the context is `{ itemId: undefined }`, which the Bun logger prints as `{}` and
        // the Rust one, having no `undefined`, leaves out: only a named item's context is compared.
        if (item_id !== undefined) expect(loggedContext("Plaid webhook status update skipped — no user for item")).toEqual({ itemId: item_id });
      }
    }
    expect(await rowOf(stack, "items", "hook-deleted-bad-item")).toMatchObject({ status: "ok", status_reason: null });
  });

  test("USER_ACCOUNT_REVOKED and ITEM_UPDATED read the item's products from Plaid again and tell the sharing group", async () => {
    const owner = await stack.login();
    const tabs = [await tab(owner), await tab(partner)];
    let n = 0;
    for (const webhook_code of ["USER_ACCOUNT_REVOKED", "ITEM_UPDATED"]) {
      n += 1;
      const { item_id, access_token } = await plaidItem(adminId, `hook-products-item-${n}`, { products: ["transactions", "investments"] });
      const result = await hook({ webhook_type: "ITEM", webhook_code, item_id });
      expect([webhook_code, result.json]).toEqual([webhook_code, SUCCESS]);
      expect(stack.upstream.plaid.calls("/item/get").at(-1)).toMatchObject({ host: PLAID_PRODUCTION_HOST, body: { access_token } });
      expect(await rowOf(stack, "items", item_id)).toMatchObject({ available_products: ["transactions", "investments"], status: "ok" });
      expect(loggedContext("Refreshed available_products for item")).toEqual({
        itemId: item_id,
        available_products: ["transactions", "investments"],
      });
      await expectEvent(tabs, "accounts-updated");
    }
  });

  test("reading the products of an item that does not exist fails without asking Plaid", async () => {
    const before = stack.upstream.plaid.calls("/item/get").length;
    for (const item_id of ["hook-missing-products-item", undefined]) {
      expect((await hook({ webhook_type: "ITEM", webhook_code: "ITEM_UPDATED", item_id })).json).toEqual(FAILED);
    }
    expect(stack.upstream.plaid.calls("/item/get")).toHaveLength(before);
  });

  test("reading the products of an item Plaid refuses is a server error", async () => {
    await seedItem(stack, adminId, "simple_fin", { item_id: "hook-products-simplefin" });
    const result = await hook({ webhook_type: "ITEM", webhook_code: "USER_ACCOUNT_REVOKED", item_id: "hook-products-simplefin" });
    expect(result.status).toBe(500);
    expect(result.json).toEqual(SERVER_ERROR);
    expect(stack.upstream.plaid.calls("/item/get").at(-1)?.body).toEqual({ access_token: "https://user:secret@bridge.simplefin.test/simplefin" });
  });
});

describe("when the key fetches are over their cap", () => {
  // The cap is process-wide and lasts a minute, so these run on a server of their own.
  let capped: Stack;
  /** Signs the webhooks that name a key Plaid never issued. */
  let signer: string;
  beforeAll(async () => {
    capped = await startStack();
    ({ kid: signer } = capped.upstream.plaid.addWebhookKey("capped-signer"));
  });
  afterAll(() => capped.stop());

  /** The webhook of `body`, naming the key `keyId`: signed by it when Plaid issued it. */
  const signedBy = (s: Stack, body: Record<string, unknown>, keyId: string) => {
    const text = JSON.stringify(body);
    let jwt: string;
    try {
      jwt = s.upstream.plaid.signWebhook(text, { kid: keyId });
    } catch {
      jwt = s.upstream.plaid.signWebhook(text, { kid: signer, header: { kid: keyId } });
    }
    return { rawBody: text, jwt, target: s };
  };

  test("ten keys not seen before are fetched a minute; past that a webhook is unverifiable, unless it names a real item, six times an hour", async () => {
    const owner = await capped.userId("admin");
    const item_id = "capped-real-item";
    await seedItem(capped, owner, "plaid", { item_id, access_token: `access-production-${item_id}` });
    const ack = (id: unknown) => ({ webhook_type: "ITEM", webhook_code: "WEBHOOK_UPDATE_ACKNOWLEDGED", item_id: id });

    // Ten keys Plaid has never issued use up the minute's fetches; each is invalid.
    for (let i = 0; i < 10; i++) {
      const result = await hook(undefined, signedBy(capped, ack("unknown"), `capped-unknown-${i}`));
      expect([i, result.status]).toEqual([i, 401]);
    }
    expect(keyFetches(capped)).toHaveLength(10);

    // The eleventh is not fetched: the webhook can't be checked yet.
    const real = capped.upstream.plaid.addWebhookKey("capped-real-key");
    const unverifiable = await hook(undefined, signedBy(capped, ack("not-an-item"), real.kid));
    expect(unverifiable.status).toBe(503);
    expect(unverifiable.json).toEqual(UNAVAILABLE);
    expect(keyFetches(capped)).toHaveLength(10);
    expect(capped.logCount("Verification key fetches over the cap; answering unavailable")).toBe(1);

    // Naming a real item gets one fetch with priority; the real key verifies and the webhook is handled.
    const handled = await hook(undefined, signedBy(capped, ack(item_id), real.kid));
    expect(handled.status).toBe(200);
    expect(handled.json).toEqual(SUCCESS);
    expect(keyFetches(capped).slice(10)).toEqual([{ key_id: real.kid }]);
    // That key has verified, so it is cached and needs no fetch.
    expect((await hook(undefined, signedBy(capped, ack("not-an-item"), real.kid))).json).toEqual(SUCCESS);

    // Five more priority attempts for the item (six in all) are fetched; the seventh is not.
    const attempts: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = keyFetches(capped).length;
      const result = await hook(undefined, signedBy(capped, ack(item_id), `capped-priority-${i}`));
      attempts.push(keyFetches(capped).length - before);
      expect([i, result.status]).toEqual([i, i < 5 ? 401 : 503]);
    }
    expect(attempts).toEqual([1, 1, 1, 1, 1, 0]);
    // The warning about the cap is written at most once a minute.
    expect(capped.logCount("Verification key fetches over the cap; answering unavailable")).toBe(1);
  });

  test("an id that isn't item-shaped never reaches the database, and neither an item that doesn't exist nor a lookup that fails gets priority", async () => {
    const owner = await capped.userId("admin");
    const ack = (id: unknown) => ({ webhook_type: "ITEM", webhook_code: "WEBHOOK_UPDATE_ACKNOWLEDGED", item_id: id });
    const before = keyFetches(capped).length;
    for (const item_id of ["a\u0000b", "x".repeat(101), "a b", "", 42, null, undefined, "capped-no-such-item"]) {
      const result = await hook(undefined, signedBy(capped, ack(item_id), "capped-shape-key"));
      expect([item_id, result.status, result.json]).toEqual([item_id, 503, UNAVAILABLE]);
    }
    // An item whose stored row cannot be read: the lookup fails, which counts as no item.
    const broken = "capped-unreadable-item";
    await seedItem(capped, owner, "plaid", { item_id: broken, access_token: `access-production-${broken}` });
    await capped.db.query(`UPDATE items SET raw = '"not an object"'::jsonb WHERE item_id = $1`, [broken]);
    const result = await hook(undefined, signedBy(capped, ack(broken), "capped-shape-key"));
    expect(result.status).toBe(503);
    await capped.waitForLog("[Plaid Webhook] Item lookup for key priority failed");
    expect(keyFetches(capped)).toHaveLength(before);

    // A real item of its own still gets its priority fetch.
    const other = "capped-other-item";
    await seedItem(capped, owner, "plaid", { item_id: other, access_token: `access-production-${other}` });
    expect((await hook(undefined, signedBy(capped, ack(other), "capped-shape-key"))).status).toBe(401);
    expect(keyFetches(capped).slice(before)).toEqual([{ key_id: "capped-shape-key" }]);
  });
});
