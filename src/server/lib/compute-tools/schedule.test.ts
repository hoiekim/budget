import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import { ItemProvider } from "common";

// `mock.module` is process-global in Bun: a relative-path mock here would also
// replace these sibling modules for every other test file in the run (e.g.
// detect-transfers.test.ts / auto-suggest.test.ts test the *real* exports).
// Capture the real modules up front so we can (a) spread their other exports
// into the mock factories and (b) restore them in afterAll.
const realServer = { ...(await import("server")) };
const realAlarm = { ...(await import("server/lib/alarm")) };
const realSyncPlaid = { ...(await import("./sync-plaid")) };
const realSyncSimpleFin = { ...(await import("./sync-simple-fin")) };
const realAutoSuggest = { ...(await import("./auto-suggest")) };
const realDetectTransfers = { ...(await import("./detect-transfers")) };

const mockGetAllItems = mock(async () => [] as { item_id: string; provider: ItemProvider }[]);
const mockUpdateItemSyncStatus = mock(async () => {});
const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
};
const mockSendAlarm = mock(async () => {});

const mockSyncPlaidAccounts = mock(
  async () => ({ accounts: [] as unknown[], investmentAccounts: [] as unknown[] }) as unknown,
);
const mockSyncPlaidTransactions = mock(
  async () => ({ added: 0, modified: 0, removed: 0 }) as unknown,
);
const mockSyncSimpleFinData = mock(
  async () =>
    ({ accounts: [], transactions: [], investmentTransactions: [] }) as unknown,
);
const mockRunAutoSuggestions = mock(async () => {});
const mockRunTransferDetection = mock(async () => {});

mock.module("server", () => ({
  ...realServer,
  getAllItems: mockGetAllItems,
  updateItemSyncStatus: mockUpdateItemSyncStatus,
  logger: mockLogger,
}));

mock.module("server/lib/alarm", () => ({
  ...realAlarm,
  sendAlarm: mockSendAlarm,
}));

mock.module("./sync-plaid", () => ({
  ...realSyncPlaid,
  syncPlaidAccounts: mockSyncPlaidAccounts,
  syncPlaidTransactions: mockSyncPlaidTransactions,
}));

mock.module("./sync-simple-fin", () => ({
  ...realSyncSimpleFin,
  syncSimpleFinData: mockSyncSimpleFinData,
}));

mock.module("./auto-suggest", () => ({
  ...realAutoSuggest,
  runAutoSuggestions: mockRunAutoSuggestions,
}));

mock.module("./detect-transfers", () => ({
  ...realDetectTransfers,
  runTransferDetection: mockRunTransferDetection,
}));

const { scheduledSync, stopScheduledSync } = await import("./schedule");

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  mockGetAllItems.mockReset();
  mockGetAllItems.mockImplementation(async () => []);
  mockUpdateItemSyncStatus.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  mockSendAlarm.mockReset();
  mockSendAlarm.mockImplementation(async () => {});
  mockSyncPlaidAccounts.mockReset();
  mockSyncPlaidAccounts.mockImplementation(
    async () => ({ accounts: [], investmentAccounts: [] }),
  );
  mockSyncPlaidTransactions.mockReset();
  mockSyncPlaidTransactions.mockImplementation(async () => ({ added: 0, modified: 0, removed: 0 }));
  mockSyncSimpleFinData.mockReset();
  mockSyncSimpleFinData.mockImplementation(
    async () => ({ accounts: [], transactions: [], investmentTransactions: [] }),
  );
  mockRunAutoSuggestions.mockReset();
  mockRunAutoSuggestions.mockImplementation(async () => {});
  mockRunTransferDetection.mockReset();
  mockRunTransferDetection.mockImplementation(async () => {});
});

afterEach(() => {
  stopScheduledSync();
});

// Restore the real sibling modules so the process-global mock.module registry
// doesn't leak our stubs into other test files run in the same process.
afterAll(() => {
  mock.module("server", () => realServer);
  mock.module("server/lib/alarm", () => realAlarm);
  mock.module("./sync-plaid", () => realSyncPlaid);
  mock.module("./sync-simple-fin", () => realSyncSimpleFin);
  mock.module("./auto-suggest", () => realAutoSuggest);
  mock.module("./detect-transfers", () => realDetectTransfers);
  restoreLeaves();
});

describe("scheduledSync / runSync", () => {
  it("syncs a Plaid item — accounts then transactions", async () => {
    mockGetAllItems.mockResolvedValueOnce([
      { item_id: "item-plaid-1", provider: ItemProvider.PLAID },
    ]);

    scheduledSync();
    await flushMicrotasks();

    expect(mockSyncPlaidAccounts).toHaveBeenCalledWith("item-plaid-1");
    expect(mockSyncPlaidTransactions).toHaveBeenCalledWith("item-plaid-1");
    expect(mockUpdateItemSyncStatus).toHaveBeenCalledWith("item-plaid-1", {
      success: true,
      error: undefined,
    });
  });

  it("skips Plaid transactions when accounts fail", async () => {
    mockGetAllItems.mockResolvedValueOnce([
      { item_id: "item-plaid-2", provider: ItemProvider.PLAID },
    ]);
    mockSyncPlaidAccounts.mockRejectedValueOnce(new Error("accounts boom"));

    scheduledSync();
    await flushMicrotasks();

    expect(mockSyncPlaidAccounts).toHaveBeenCalledTimes(1);
    expect(mockSyncPlaidTransactions).toHaveBeenCalledTimes(0);
    expect(mockSendAlarm).toHaveBeenCalledTimes(1);
    expect(mockUpdateItemSyncStatus).toHaveBeenCalledWith("item-plaid-2", {
      success: false,
      error: "accounts boom",
    });
  });

  it("records error when Plaid transactions fail", async () => {
    mockGetAllItems.mockResolvedValueOnce([
      { item_id: "item-plaid-3", provider: ItemProvider.PLAID },
    ]);
    mockSyncPlaidTransactions.mockRejectedValueOnce(new Error("txn fail"));

    scheduledSync();
    await flushMicrotasks();

    expect(mockSyncPlaidAccounts).toHaveBeenCalledTimes(1);
    expect(mockSyncPlaidTransactions).toHaveBeenCalledTimes(1);
    expect(mockSendAlarm).toHaveBeenCalledTimes(1);
    expect(mockUpdateItemSyncStatus).toHaveBeenCalledWith("item-plaid-3", {
      success: false,
      error: "txn fail",
    });
  });

  it("sends alarm when Plaid accounts returns null", async () => {
    mockGetAllItems.mockResolvedValueOnce([
      { item_id: "item-null", provider: ItemProvider.PLAID },
    ]);
    mockSyncPlaidAccounts.mockResolvedValueOnce(null);

    scheduledSync();
    await flushMicrotasks();

    expect(mockSendAlarm).toHaveBeenCalledTimes(1);
    expect(mockSyncPlaidTransactions).toHaveBeenCalledTimes(0);
  });

  it("syncs a SimpleFin item", async () => {
    mockGetAllItems.mockResolvedValueOnce([
      { item_id: "item-sf-1", provider: ItemProvider.SIMPLE_FIN },
    ]);

    scheduledSync();
    await flushMicrotasks();

    expect(mockSyncSimpleFinData).toHaveBeenCalledWith("item-sf-1");
    expect(mockUpdateItemSyncStatus).toHaveBeenCalledWith("item-sf-1", {
      success: true,
      error: undefined,
    });
  });

  it("records error when SimpleFin sync fails", async () => {
    mockGetAllItems.mockResolvedValueOnce([
      { item_id: "item-sf-2", provider: ItemProvider.SIMPLE_FIN },
    ]);
    mockSyncSimpleFinData.mockRejectedValueOnce(new Error("sf boom"));

    scheduledSync();
    await flushMicrotasks();

    expect(mockSendAlarm).toHaveBeenCalledTimes(1);
    expect(mockUpdateItemSyncStatus).toHaveBeenCalledWith("item-sf-2", {
      success: false,
      error: "sf boom",
    });
  });

  it("runs auto-suggestions and transfer detection after provider sync", async () => {
    mockGetAllItems.mockResolvedValueOnce([]);

    scheduledSync();
    await flushMicrotasks();

    expect(mockRunAutoSuggestions).toHaveBeenCalledTimes(1);
    expect(mockRunTransferDetection).toHaveBeenCalledTimes(1);
  });

  it("swallows auto-suggestion errors without blocking transfer detection", async () => {
    mockGetAllItems.mockResolvedValueOnce([]);
    mockRunAutoSuggestions.mockRejectedValueOnce(new Error("suggest fail"));

    scheduledSync();
    await flushMicrotasks();

    expect(mockRunTransferDetection).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("sends alarm when getAllItems throws", async () => {
    mockGetAllItems.mockRejectedValueOnce(new Error("db down"));

    scheduledSync();
    await flushMicrotasks();

    expect(mockSendAlarm).toHaveBeenCalledTimes(1);
  });
});

describe("re-entry guard", () => {
  it("skips if a previous sync is still running", async () => {
    let resolveFirst!: () => void;
    const blockingPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });
    mockGetAllItems.mockImplementationOnce(() => blockingPromise.then(() => []));

    scheduledSync();
    await flushMicrotasks();

    scheduledSync();
    await flushMicrotasks();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Skipping scheduled sync — previous sync still running",
    );

    resolveFirst();
    await flushMicrotasks();
  });
});

describe("stopScheduledSync", () => {
  it("cancels the interval so no further syncs run", () => {
    scheduledSync();
    stopScheduledSync();
    stopScheduledSync();
  });
});
