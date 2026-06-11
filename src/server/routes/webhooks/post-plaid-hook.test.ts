import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import { ItemStatus } from "common";

// `mock.module` is process-global in Bun, and `restoreLeaves` only restores the
// `pg` / `bcrypt` leaves. So we capture the real `server` barrel + the deep
// `alarm` / `logger` modules up front, spread their other exports into the mock
// factories, and restore them in `afterAll` (the schedule.test.ts pattern) so
// our stubs don't leak into sibling route tests run in the same process.
const realServer = { ...(await import("server")) };
const realAlarm = { ...(await import("server/lib/alarm")) };
const realLogger = { ...(await import("server/lib/logger")) };

const mockVerifyWebhook = mock(async (_rawBody: string, _jwt?: string) => true);
const mockGetItem = mock(async (_accessToken: string) => ({
  consented_products: [] as string[],
  products: [] as string[],
}));
const mockSyncPlaidTransactions = mock(
  async (_itemId: string) => ({ added: 0, modified: 0, removed: 0 }) as unknown,
);
const mockUpdateItemStatus = mock(
  async (_itemId: string, _status: ItemStatus) => true as unknown,
);
const mockGetUserItem = mock(
  async (_itemId: string) =>
    ({
      user: { user_id: "u-1", username: "alice" },
      item: { item_id: "item-1", access_token: "access-tok" },
    }) as unknown,
);
const mockUpsertItems = mock(
  async (_user: unknown, _items: unknown[]) => [] as unknown[],
);
const mockSendAlarm = mock(async () => {});
const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
};

mock.module("server", () => ({
  ...realServer,
  plaid: {
    ...realServer.plaid,
    verifyWebhook: mockVerifyWebhook,
    getItem: mockGetItem,
  },
  syncPlaidTransactions: mockSyncPlaidTransactions,
  updateItemStatus: mockUpdateItemStatus,
  getUserItem: mockGetUserItem,
  upsertItems: mockUpsertItems,
}));

mock.module("server/lib/alarm", () => ({
  ...realAlarm,
  sendAlarm: mockSendAlarm,
}));

mock.module("server/lib/logger", () => ({
  ...realLogger,
  logger: mockLogger,
}));

const { postPlaidHookRoute } = await import("./post-plaid-hook");

afterAll(() => {
  mock.module("server", () => realServer);
  mock.module("server/lib/alarm", () => realAlarm);
  mock.module("server/lib/logger", () => realLogger);
  restoreLeaves();
});

beforeEach(() => {
  mockVerifyWebhook.mockReset();
  mockVerifyWebhook.mockImplementation(async () => true);
  mockGetItem.mockReset();
  mockGetItem.mockImplementation(async () => ({
    consented_products: [],
    products: [],
  }));
  mockSyncPlaidTransactions.mockReset();
  mockSyncPlaidTransactions.mockImplementation(async () => ({
    added: 0,
    modified: 0,
    removed: 0,
  }));
  mockUpdateItemStatus.mockReset();
  mockUpdateItemStatus.mockImplementation(async () => true);
  mockGetUserItem.mockReset();
  mockGetUserItem.mockImplementation(async () => ({
    user: { user_id: "u-1", username: "alice" },
    item: { item_id: "item-1", access_token: "access-tok" },
  }));
  mockUpsertItems.mockReset();
  mockUpsertItems.mockImplementation(async () => []);
  mockSendAlarm.mockReset();
  mockSendAlarm.mockImplementation(async () => {});
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
});

interface ReqOpts {
  rawBody?: string | undefined;
  signedJwt?: string;
}

function makeReq(
  body: unknown,
  opts: ReqOpts = {},
): Parameters<typeof postPlaidHookRoute.execute>[0] {
  const headers: Record<string, string> = {};
  if (opts.signedJwt !== undefined)
    headers["plaid-verification"] = opts.signedJwt;
  return {
    method: "POST",
    path: "/plaid-hook",
    url: "http://x/api/plaid-hook",
    headers,
    query: {},
    body,
    rawBody: opts.rawBody,
    ip: "127.0.0.1",
  } as unknown as Parameters<typeof postPlaidHookRoute.execute>[0];
}

const makeRes = () => {
  const res = {
    statusCode: 200,
    headersSent: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    write() {
      return true;
    },
    end() {},
  };
  return res as unknown as Parameters<typeof postPlaidHookRoute.execute>[1];
};

/** Drive the route with a verified-by-default signed body. */
const run = (body: unknown, opts: ReqOpts = {}) => {
  const res = makeRes();
  return postPlaidHookRoute
    .execute(makeReq(body, { rawBody: "raw", signedJwt: "jwt", ...opts }), res)
    .then((result) => ({ result, res }));
};

describe("post-plaid-hook — auth boundary", () => {
  test("missing rawBody → 401 and verifyWebhook is never called", async () => {
    const { result, res } = await run(
      { webhook_type: "ITEM", webhook_code: "X", item_id: "i" },
      {
        rawBody: undefined,
      },
    );
    expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
    expect(result).toMatchObject({ status: "failed" });
    expect(mockVerifyWebhook).not.toHaveBeenCalled();
  });

  test("invalid signature → 401 and no dispatch to sync", async () => {
    mockVerifyWebhook.mockImplementation(async () => false);
    const { result, res } = await run({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "i",
    });
    expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
    expect(result).toMatchObject({ status: "failed" });
    expect(mockSyncPlaidTransactions).not.toHaveBeenCalled();
  });

  test("verifyWebhook receives the raw body and the plaid-verification header", async () => {
    await run(
      {
        webhook_type: "ITEM",
        webhook_code: "WEBHOOK_UPDATE_ACKNOWLEDGED",
        item_id: "i",
      },
      {
        rawBody: "the-raw-body",
        signedJwt: "the-jwt",
      },
    );
    expect(mockVerifyWebhook).toHaveBeenCalledWith("the-raw-body", "the-jwt");
  });

  test("valid signature + non-object body → validationError, no dispatch", async () => {
    const { result } = await run("not-an-object");
    expect(result).toMatchObject({ status: "failed" });
    expect(result?.message).toBeTruthy();
    expect(mockSyncPlaidTransactions).not.toHaveBeenCalled();
  });
});

describe("post-plaid-hook — TRANSACTIONS", () => {
  test("SYNC_UPDATES_AVAILABLE syncs and returns success", async () => {
    const { result } = await run({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-7",
    });
    expect(mockSyncPlaidTransactions).toHaveBeenCalledWith("item-7");
    expect(result).toMatchObject({ status: "success" });
  });

  test("SYNC_UPDATES_AVAILABLE with null sync result → failed", async () => {
    mockSyncPlaidTransactions.mockImplementation(async () => null);
    const { result } = await run({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-7",
    });
    expect(result).toMatchObject({ status: "failed" });
  });

  for (const code of [
    "DEFAULT_UPDATE",
    "INITIAL_UPDATE",
    "HISTORICAL_UPDATE",
    "TRANSACTIONS_REMOVED",
  ]) {
    test(`${code} → success without syncing`, async () => {
      const { result } = await run({
        webhook_type: "TRANSACTIONS",
        webhook_code: code,
        item_id: "i",
      });
      expect(result).toMatchObject({ status: "success" });
      expect(mockSyncPlaidTransactions).not.toHaveBeenCalled();
    });
  }

  test("unknown code → warn path returns null", async () => {
    const { result } = await run({
      webhook_type: "TRANSACTIONS",
      webhook_code: "NOPE",
      item_id: "i",
    });
    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});

describe("post-plaid-hook — ITEM", () => {
  test("WEBHOOK_UPDATE_ACKNOWLEDGED → success, no side effects", async () => {
    const { result } = await run({
      webhook_type: "ITEM",
      webhook_code: "WEBHOOK_UPDATE_ACKNOWLEDGED",
      item_id: "i",
    });
    expect(result).toMatchObject({ status: "success" });
    expect(mockUpdateItemStatus).not.toHaveBeenCalled();
  });

  test("PENDING_EXPIRATION → marks item BAD and alarms", async () => {
    const { result } = await run({
      webhook_type: "ITEM",
      webhook_code: "PENDING_EXPIRATION",
      item_id: "item-9",
    });
    expect(mockUpdateItemStatus).toHaveBeenCalledWith("item-9", ItemStatus.BAD);
    expect(mockSendAlarm).toHaveBeenCalled();
    expect(result).toMatchObject({ status: "success" });
  });

  test("ERROR + ITEM_LOGIN_REQUIRED → marks item BAD and alarms", async () => {
    const { result } = await run({
      webhook_type: "ITEM",
      webhook_code: "ERROR",
      item_id: "item-9",
      error: { error_code: "ITEM_LOGIN_REQUIRED" },
    });
    expect(mockUpdateItemStatus).toHaveBeenCalledWith("item-9", ItemStatus.BAD);
    expect(mockSendAlarm).toHaveBeenCalled();
    expect(result).toMatchObject({ status: "success" });
  });

  test("ERROR + other error_code → warn path, no status change", async () => {
    const { result } = await run({
      webhook_type: "ITEM",
      webhook_code: "ERROR",
      item_id: "i",
      error: { error_code: "SOMETHING_ELSE" },
    });
    expect(result).toBeNull();
    expect(mockUpdateItemStatus).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  test("PENDING_EXPIRATION with failed status update → failed, no alarm", async () => {
    mockUpdateItemStatus.mockImplementation(async () => null);
    const { result } = await run({
      webhook_type: "ITEM",
      webhook_code: "PENDING_EXPIRATION",
      item_id: "i",
    });
    expect(result).toMatchObject({ status: "failed" });
    expect(mockSendAlarm).not.toHaveBeenCalled();
  });

  for (const code of ["USER_ACCOUNT_REVOKED", "ITEM_UPDATED"]) {
    test(`${code} → refreshes item products`, async () => {
      const { result } = await run({
        webhook_type: "ITEM",
        webhook_code: code,
        item_id: "item-5",
      });
      expect(mockGetUserItem).toHaveBeenCalledWith("item-5");
      expect(mockGetItem).toHaveBeenCalledWith("access-tok");
      expect(mockUpsertItems).toHaveBeenCalled();
      expect(result).toMatchObject({ status: "success" });
    });
  }

  test("refresh path with missing user item → failed, no upsert", async () => {
    mockGetUserItem.mockImplementation(async () => null);
    const { result } = await run({
      webhook_type: "ITEM",
      webhook_code: "ITEM_UPDATED",
      item_id: "i",
    });
    expect(result).toMatchObject({ status: "failed" });
    expect(mockUpsertItems).not.toHaveBeenCalled();
  });

  test("unknown code → warn path returns null", async () => {
    const { result } = await run({
      webhook_type: "ITEM",
      webhook_code: "MYSTERY",
      item_id: "i",
    });
    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});

describe("post-plaid-hook — HOLDINGS", () => {
  test("DEFAULT_UPDATE → syncs and returns success", async () => {
    const { result } = await run({
      webhook_type: "HOLDINGS",
      webhook_code: "DEFAULT_UPDATE",
      item_id: "item-h",
    });
    expect(mockSyncPlaidTransactions).toHaveBeenCalledWith("item-h");
    expect(result).toMatchObject({ status: "success" });
  });

  test("unknown code → warn path returns null", async () => {
    const { result } = await run({
      webhook_type: "HOLDINGS",
      webhook_code: "NOPE",
      item_id: "i",
    });
    expect(result).toBeNull();
    expect(mockSyncPlaidTransactions).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});

describe("post-plaid-hook — INVESTMENTS_TRANSACTIONS", () => {
  for (const code of ["DEFAULT_UPDATE", "HISTORICAL_UPDATE"]) {
    test(`${code} → syncs and returns success`, async () => {
      const { result } = await run({
        webhook_type: "INVESTMENTS_TRANSACTIONS",
        webhook_code: code,
        item_id: "item-iv",
      });
      expect(mockSyncPlaidTransactions).toHaveBeenCalledWith("item-iv");
      expect(result).toMatchObject({ status: "success" });
    });
  }

  test("unknown code → warn path returns null", async () => {
    const { result } = await run({
      webhook_type: "INVESTMENTS_TRANSACTIONS",
      webhook_code: "NOPE",
      item_id: "i",
    });
    expect(result).toBeNull();
    expect(mockSyncPlaidTransactions).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
