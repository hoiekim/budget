import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import { ItemProvider } from "common";
import { Products } from "plaid";

// Sync-level sequencing test for the pending→posted split re-point.
// syncPlaidTransactions has no live Plaid here, so the whole "server"
// surface is faked and the test pins the ORDER of the calls: upsert,
// then re-point, then the removal cascade. The re-point mock returns a
// deferred promise the test controls, so any refactor that starts the
// cascade before the re-point resolves fails here — including the two
// mutations from the review (a single Promise.all for the whole chain,
// or the re-point block moved after the deleteTransactions Promise.all),
// which would both invoke the deletes while the re-point is still
// pending.

const testUser = { user_id: "usr-1", username: "test" };
const testItem = {
  item_id: "item-1",
  institution_id: "ins-1",
  provider: ItemProvider.PLAID,
  available_products: [Products.Transactions],
} as const;

const storedPending = {
  transaction_id: "PENDING-1",
  account_id: "acc-1",
  name: "Coffee",
  amount: 5,
  pending_transaction_id: null,
  label: {},
};

const postedTx = {
  transaction_id: "POSTED-1",
  pending_transaction_id: "PENDING-1",
  account_id: "acc-1",
  name: "Coffee",
  amount: 5,
  date: "2026-03-01",
  authorized_date: "2026-03-01",
};

const transitionBatch = {
  items: [{ item_id: "item-1", cursor: "cursor-1" }],
  added: [postedTx],
  removed: [{ transaction_id: "PENDING-1" }],
  modified: [],
};

const noTransitionBatch = {
  items: [{ item_id: "item-1", cursor: "cursor-1" }],
  added: [{ ...postedTx, transaction_id: "POSTED-9", pending_transaction_id: null }],
  removed: [],
  modified: [],
};

const realServer = { ...(await import("server")) };

const mockGetUserItem = mock(async () => ({ user: testUser, item: testItem }));
const mockSearchAccountsByItemId = mock(async () => [{ account_id: "acc-1" }]);
const mockSearchTransactionsByAccountId = mock(async () => ({
  transactions: [storedPending],
  investment_transactions: [],
}));
const mockGetTransactions = mock(async () => transitionBatch);
const mockUpsertTransactions = mock(async () => {});
const mockDeleteTransactions = mock(async () => {});
const mockDeleteSplitTransactionsByTransaction = mock(async () => ({ deleted: 1 }));
const mockMigrateRejectedCategories = mock(async () => 0);
const mockUpsertItems = mock(async () => {});
const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
};

let resolveRepoint: (n: number) => void = () => {};
let rejectRepoint: (e: unknown) => void = () => {};
let repointDeferred: Promise<number> = Promise.resolve(0);
const resetRepointDeferred = () => {
  repointDeferred = new Promise<number>((res, rej) => {
    resolveRepoint = res;
    rejectRepoint = rej;
  });
};
const mockRepoint = mock(() => repointDeferred);

mock.module("server", () => ({
  ...realServer,
  getUserItem: mockGetUserItem,
  searchAccountsByItemId: mockSearchAccountsByItemId,
  searchTransactionsByAccountId: mockSearchTransactionsByAccountId,
  plaid: { getTransactions: mockGetTransactions },
  upsertTransactions: mockUpsertTransactions,
  deleteTransactions: mockDeleteTransactions,
  deleteSplitTransactionsByTransaction: mockDeleteSplitTransactionsByTransaction,
  migrateRejectedCategoriesOnPendingPosted: mockMigrateRejectedCategories,
  repointSplitTransactionsOnPendingPosted: mockRepoint,
  upsertItems: mockUpsertItems,
  logger: mockLogger,
}));

const { syncPlaidTransactions } = await import("./sync-plaid");

// `mock.module("server")` leaks across files in one `bun test` run, so
// restore the real server module (and the leaf snapshots) when this file
// is done — otherwise the next file's imports resolve against this
// file's fakes.
afterAll(() => {
  mock.module("server", () => realServer);
  restoreLeaves();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mockGetUserItem.mockClear();
  mockSearchAccountsByItemId.mockClear();
  mockSearchTransactionsByAccountId.mockClear();
  mockGetTransactions.mockClear();
  mockUpsertTransactions.mockClear();
  mockDeleteTransactions.mockClear();
  mockDeleteSplitTransactionsByTransaction.mockClear();
  mockMigrateRejectedCategories.mockClear();
  mockUpsertItems.mockClear();
  mockRepoint.mockClear();
  mockLogger.warn.mockClear();
  resetRepointDeferred();
});

describe("syncPlaidTransactions — pending→posted re-point sequencing", () => {
  test("re-point runs after upsert and before the removal cascade for a transition pair", async () => {
    const syncPromise = syncPlaidTransactions("item-1");
    // Let the chain run until it parks on the unresolved re-point.
    await tick();
    await tick();
    expect(mockUpsertTransactions).toHaveBeenCalled();
    expect(mockRepoint).toHaveBeenCalledTimes(1);
    expect(mockRepoint).toHaveBeenCalledWith(testUser, "PENDING-1", "POSTED-1");
    // The cascade must not have started while the re-point is pending:
    // this is the assertion the old single-Promise.all shape and the
    // re-point-after-deletes shape both violate.
    expect(mockDeleteTransactions).not.toHaveBeenCalled();
    expect(mockDeleteSplitTransactionsByTransaction).not.toHaveBeenCalled();

    resolveRepoint(2);
    const result = await syncPromise;
    expect(mockDeleteTransactions).toHaveBeenCalledWith(testUser, ["PENDING-1"]);
    expect(mockDeleteSplitTransactionsByTransaction).toHaveBeenCalledWith(
      testUser,
      "PENDING-1",
    );
    expect(result).toEqual({ user_id: "usr-1", added: 1, modified: 0, removed: 1 });
  });

  test("a failed re-point warns and still runs the removal cascade", async () => {
    const syncPromise = syncPlaidTransactions("item-1");
    await tick();
    await tick();
    expect(mockRepoint).toHaveBeenCalledTimes(1);
    rejectRepoint(new Error("re-point failed"));
    const result = await syncPromise;
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(mockDeleteTransactions).toHaveBeenCalledWith(testUser, ["PENDING-1"]);
    expect(mockDeleteSplitTransactionsByTransaction).toHaveBeenCalledWith(
      testUser,
      "PENDING-1",
    );
    expect(result.removed).toBe(1);
  });

  test("no re-point is issued when the batch carries no transition pair", async () => {
    mockGetTransactions.mockImplementationOnce(async () => noTransitionBatch);
    const result = await syncPlaidTransactions("item-1");
    expect(mockRepoint).not.toHaveBeenCalled();
    expect(mockDeleteTransactions).toHaveBeenCalledWith(testUser, []);
    expect(result).toEqual({ user_id: "usr-1", added: 1, modified: 0, removed: 0 });
  });
});
