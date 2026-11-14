/**
 * Tests for the scheduled sync when Plaid is NOT configured.
 *
 * The main schedule.test.ts mocks `isPlaidConfigured: true` to exercise the
 * sync orchestration. This file covers the opposite: with no PLAID_* vars
 * (the real module value in the test env), Plaid items must be skipped
 * without any Plaid API calls. It imports a fresh copy of schedule.ts via a
 * cache-busting query so the unconfigured flag is seen at module load.
 */

import { describe, test, expect, mock, afterAll } from "bun:test";
import { ItemProvider } from "common";

const realPlaidUtil = { ...(await import("server/lib/plaid/util")) };
const realServer = { ...(await import("server")) };
const realSyncPlaid = { ...(await import("./sync-plaid")) };
const realAutoSuggest = { ...(await import("./auto-suggest")) };
const realDetectTransfers = { ...(await import("./detect-transfers")) };
const realDetectRecurrings = { ...(await import("./detect-recurrings")) };
const realRefreshSecuritySnapshots = {
  ...(await import("./refresh-security-snapshots")),
};

const mockGetAllItems = mock(
  async () => [] as { item_id: string; provider: ItemProvider }[],
);
const mockSyncPlaidAccounts = mock(async () => {
  throw new Error("must not be called");
});
const mockSyncPlaidTransactions = mock(async () => {
  throw new Error("must not be called");
});
const mockRunAutoSuggestions = mock(async () => {});
const mockRunTransferDetection = mock(async () => {});
const mockRunRecurringDetection = mock(async () => {});
const mockRefreshActiveSecuritySnapshots = mock(async () => ({
  refreshed: 0,
  fresh: 0,
  cash: 0,
  empty: 0,
  errors: 0,
}));
const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
};

mock.module("server/lib/plaid/util", () => ({
  ...realPlaidUtil,
  // Real value in the test env (no PLAID_* vars) — do NOT override to true.
  isPlaidConfigured: false,
}));
mock.module("server", () => ({
  ...realServer,
  getAllItems: mockGetAllItems,
  updateItemSyncStatus: mock(async () => {}),
  logger: mockLogger,
}));
mock.module("./sync-plaid", () => ({
  ...realSyncPlaid,
  syncPlaidAccounts: mockSyncPlaidAccounts,
  syncPlaidTransactions: mockSyncPlaidTransactions,
}));
// The sync goes on to these jobs after the Plaid loop. Left real, they reach
// the database and the global fetch after this file ends, inside other files.
mock.module("./auto-suggest", () => ({
  ...realAutoSuggest,
  runAutoSuggestions: mockRunAutoSuggestions,
}));
mock.module("./detect-transfers", () => ({
  ...realDetectTransfers,
  runTransferDetection: mockRunTransferDetection,
}));
mock.module("./detect-recurrings", () => ({
  ...realDetectRecurrings,
  runRecurringDetection: mockRunRecurringDetection,
}));
mock.module("./refresh-security-snapshots", () => ({
  ...realRefreshSecuritySnapshots,
  refreshActiveSecuritySnapshots: mockRefreshActiveSecuritySnapshots,
}));

// Fresh module instance that sees isPlaidConfigured=false at load.
// The `?unconfigured` query keeps this separate from schedule.test.ts's import.
const { scheduledSync, stopScheduledSync } = (await import(
  "./schedule.ts?unconfigured"
)) as typeof import("./schedule");

afterAll(() => {
  stopScheduledSync();
  mock.module("server/lib/plaid/util", () => realPlaidUtil);
  mock.module("server", () => realServer);
  mock.module("./sync-plaid", () => realSyncPlaid);
  mock.module("./auto-suggest", () => realAutoSuggest);
  mock.module("./detect-transfers", () => realDetectTransfers);
  mock.module("./detect-recurrings", () => realDetectRecurrings);
  mock.module("./refresh-security-snapshots", () => realRefreshSecuritySnapshots);
});

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 50));

describe("scheduledSync without Plaid configuration", () => {
  test("skips Plaid items without calling Plaid", async () => {
    mockGetAllItems.mockResolvedValueOnce([
      { item_id: "item-plaid-1", provider: ItemProvider.PLAID },
    ]);

    scheduledSync();
    await flushMicrotasks();

    expect(mockSyncPlaidAccounts).not.toHaveBeenCalled();
    expect(mockSyncPlaidTransactions).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringMatching(/Plaid is not configured/),
    );
    expect(mockRunAutoSuggestions).toHaveBeenCalledTimes(1);
    expect(mockRunTransferDetection).toHaveBeenCalledTimes(1);
    expect(mockRunRecurringDetection).toHaveBeenCalledTimes(1);
    expect(mockRefreshActiveSecuritySnapshots).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith("Scheduled sync completed");
  });
});
