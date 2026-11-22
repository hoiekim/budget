/**
 * The foreground Plaid routes on the configured path: which call each one
 * bounds on the shared gate, and what a shed call returns. `isPlaidConfigured`
 * is false in the test env, so `server` is mocked to reach that path.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import { ItemProvider, QueueWaitTimeoutError } from "common";

// `mock.module` is process-global in Bun; snapshot the real modules so
// `afterAll` can put them back for the suites that run after this one.
const realServer = { ...(await import("server")) };
const realAlarm = { ...(await import("server/lib/alarm")) };
const realLogger = { ...(await import("server/lib/logger")) };

const FOREGROUND = realServer.plaid.PLAID_FOREGROUND_WAIT_MS;

const plaidItem = {
  item_id: "item-1",
  access_token: "access-tok",
  provider: ItemProvider.PLAID,
  institution_id: "ins_1",
  available_products: [],
};

const mockGetLinkToken = mock(async (..._args: unknown[]) => ({ link_token: "link-tok" }));
const mockExchangePublicToken = mock(async (..._args: unknown[]) => ({
  access_token: "access-tok",
  item_id: "item-1",
}));
const mockPlaidGetItem = mock(async (..._args: unknown[]) => ({
  consented_products: [],
  products: [],
}));
const mockPlaidDeleteItem = mock(async (..._args: unknown[]) => {});
const mockGetInstitutionsByIds = mock(async (..._args: unknown[]) => [] as unknown[]);
const mockUpsertItems = mock(async (..._args: unknown[]) => [] as unknown[]);
const mockSyncPlaidAccounts = mock(async (..._args: unknown[]) => undefined);
const mockSyncPlaidTransactions = mock(async (..._args: unknown[]) => undefined);
const mockSearchItems = mock(async (..._args: unknown[]) => [plaidItem] as unknown[]);
const mockDeleteItem = mock(async (..._args: unknown[]) => undefined);
const mockSearchInstitutionsById = mock(async (..._args: unknown[]) => [] as unknown[]);
const mockUpsertInstitutions = mock(async (..._args: unknown[]) => [] as unknown[]);
const mockSendAlarm = mock(async (..._args: unknown[]) => {});
const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
};

mock.module("server", () => ({
  ...realServer,
  plaid: {
    ...realServer.plaid,
    isPlaidConfigured: true,
    getLinkToken: mockGetLinkToken,
    exchangePublicToken: mockExchangePublicToken,
    getItem: mockPlaidGetItem,
    deleteItem: mockPlaidDeleteItem,
    getInstitutionsByIds: mockGetInstitutionsByIds,
  },
  upsertItems: mockUpsertItems,
  syncPlaidAccounts: mockSyncPlaidAccounts,
  syncPlaidTransactions: mockSyncPlaidTransactions,
  searchItems: mockSearchItems,
  deleteItem: mockDeleteItem,
  searchInstitutionsById: mockSearchInstitutionsById,
  upsertInstitutions: mockUpsertInstitutions,
}));

mock.module("server/lib/alarm", () => ({
  ...realAlarm,
  sendAlarm: mockSendAlarm,
}));

mock.module("server/lib/logger", () => ({
  ...realLogger,
  logger: mockLogger,
}));

const { getLinkTokenRoute } = await import("./get-link-token");
const { postPublicTokenRoute } = await import("./post-public-token");
const { deleteItemRoute } = await import("./delete-item");
const { getInstitutionsRoute } = await import("../accounts/get-institutions");

afterAll(() => {
  mock.module("server", () => realServer);
  mock.module("server/lib/alarm", () => realAlarm);
  mock.module("server/lib/logger", () => realLogger);
  restoreLeaves();
});

const allMocks = [
  mockGetLinkToken,
  mockExchangePublicToken,
  mockPlaidGetItem,
  mockPlaidDeleteItem,
  mockGetInstitutionsByIds,
  mockUpsertItems,
  mockSyncPlaidAccounts,
  mockSyncPlaidTransactions,
  mockSearchItems,
  mockDeleteItem,
  mockSearchInstitutionsById,
  mockUpsertInstitutions,
  mockSendAlarm,
  mockLogger.info,
  mockLogger.warn,
  mockLogger.error,
];

beforeEach(() => {
  for (const m of allMocks) m.mockClear();
  mockGetLinkToken.mockImplementation(async () => ({ link_token: "link-tok" }));
  mockExchangePublicToken.mockImplementation(async () => ({
    access_token: "access-tok",
    item_id: "item-1",
  }));
  mockPlaidDeleteItem.mockImplementation(async () => {});
  mockGetInstitutionsByIds.mockImplementation(async () => []);
  mockSearchItems.mockImplementation(async () => [plaidItem]);
});

let userSeq = 0;

type Req = Parameters<typeof getLinkTokenRoute.execute>[0];

function makeReq(method: string, path: string, query: Record<string, unknown>, body?: unknown) {
  userSeq += 1;
  return {
    method,
    path,
    url: `http://x/api${path}`,
    headers: {},
    query,
    body,
    session: {
      id: "s-1",
      user: { user_id: `u-${userSeq}`, username: "test" },
      regenerate() {},
      destroy() {},
    },
    ip: "127.0.0.1",
  } as unknown as Req;
}

const makeRes = () => {
  const res = {
    statusCode: 200,
    headersSent: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    write() {},
    end() {},
    setHeader() {},
  };
  return res as typeof res & Parameters<typeof getLinkTokenRoute.execute>[1];
};

const shed = () => new QueueWaitTimeoutError(FOREGROUND);

const linkToken = () => makeReq("GET", "/link-token", {});
const publicToken = () =>
  makeReq(
    "POST",
    "/public-token",
    { provider: ItemProvider.PLAID },
    { public_token: "public-tok", institution_id: "ins_1" },
  );
const removeItem = () => makeReq("DELETE", "/item", { id: "item-1" });

describe("foreground Plaid routes bound only their first call", () => {
  test("GET /link-token bounds getLinkToken", async () => {
    const result = await getLinkTokenRoute.execute(linkToken(), makeRes());
    expect(result).toEqual({ status: "success", body: "link-tok" });
    expect(mockGetLinkToken.mock.calls[0][2]).toEqual({ maxWaitMs: FOREGROUND });
  });

  test("POST /public-token bounds the exchange and leaves the getItem after it unbounded", async () => {
    const result = await postPublicTokenRoute.execute(publicToken(), makeRes());
    expect(result).toMatchObject({ status: "success" });
    expect(mockExchangePublicToken.mock.calls[0][2]).toEqual({ maxWaitMs: FOREGROUND });
    expect(mockPlaidGetItem.mock.calls).toEqual([["access-tok"]]);
  });

  test("DELETE /item bounds the remote revocation", async () => {
    const result = await deleteItemRoute.execute(removeItem(), makeRes());
    expect(result).toEqual({ status: "success" });
    expect(mockPlaidDeleteItem.mock.calls[0][2]).toEqual({ maxWaitMs: FOREGROUND });
  });

  test("GET /institutions bounds the Plaid fallback", async () => {
    const req = makeReq("GET", "/institutions", { ids: "ins_9" });
    const result = await getInstitutionsRoute.execute(req, makeRes());
    expect(result).toEqual({ status: "success", body: [] });
    expect(mockGetInstitutionsByIds.mock.calls[0][2]).toEqual({ maxWaitMs: FOREGROUND });
  });
});

describe("a shed foreground call is a retryable 503, not a route error", () => {
  const expectShed = (res: ReturnType<typeof makeRes>, result: unknown) => {
    expect(res.statusCode).toBe(503);
    expect(result).toEqual({ status: "failed", message: realServer.plaid.PLAID_BUSY_MESSAGE });
    expect(mockSendAlarm).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  };

  test("GET /link-token", async () => {
    mockGetLinkToken.mockImplementation(async () => {
      throw shed();
    });
    const res = makeRes();
    expectShed(res, await getLinkTokenRoute.execute(linkToken(), res));
  });

  test("POST /public-token stores nothing", async () => {
    mockExchangePublicToken.mockImplementation(async () => {
      throw shed();
    });
    const res = makeRes();
    expectShed(res, await postPublicTokenRoute.execute(publicToken(), res));
    expect(mockPlaidGetItem).not.toHaveBeenCalled();
    expect(mockUpsertItems).not.toHaveBeenCalled();
  });

  test("DELETE /item keeps the local item", async () => {
    mockPlaidDeleteItem.mockImplementation(async () => {
      throw shed();
    });
    const res = makeRes();
    expectShed(res, await deleteItemRoute.execute(removeItem(), res));
    expect(mockDeleteItem).not.toHaveBeenCalled();
  });

  test("any other Plaid failure still reaches the route error handler", async () => {
    mockGetLinkToken.mockImplementation(async () => {
      throw new Error("plaid exploded");
    });
    const res = makeRes();
    const result = await getLinkTokenRoute.execute(linkToken(), res);
    expect(res.statusCode).toBe(500);
    expect(result).toEqual({ status: "error", message: "Internal server error" });
    expect(mockSendAlarm).toHaveBeenCalledTimes(1);
  });
});
