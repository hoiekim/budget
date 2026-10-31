import { describe, test, expect } from "bun:test";
import {
  paintStage1,
  paintCachedWarm,
  paintAccountsFailure,
  paintRecentWindow,
  applyDelta,
  cursorUpdateAfterSync,
  sortById,
  type Stage1Fetched,
  type PartitionedFetched,
} from "./sync";
import {
  Data,
  Account,
  AccountDictionary,
  AccountSnapshot,
  AccountSnapshotDictionary,
  Budget,
  BudgetDictionary,
  CategoryDictionary,
  ChartDictionary,
  HoldingDictionary,
  HoldingSnapshotDictionary,
  InstitutionDictionary,
  InvestmentTransaction,
  InvestmentTransactionDictionary,
  ItemDictionary,
  SectionDictionary,
  SecurityDictionary,
  SecuritySnapshotDictionary,
  SplitTransaction,
  SplitTransactionDictionary,
  Transaction,
  TransactionDictionary,
  TransferDictionary,
  RecurringDictionary,
} from "client";
import type { TransferPair, Recurring } from "server";

describe("cursorUpdateAfterSync", () => {
  test("advances after a clean sync", () => {
    expect(
      cursorUpdateAfterSync({
        purgeFailed: false,
        fetchFailed: false,
        idbFailed: false,
        writesSkipped: false,
      }),
    ).toBe("advance");
  });

  test("keeps the cursor when a fetch or a save failed", () => {
    expect(
      cursorUpdateAfterSync({
        purgeFailed: false,
        fetchFailed: true,
        idbFailed: false,
        writesSkipped: false,
      }),
    ).toBe("keep");
    expect(
      cursorUpdateAfterSync({
        purgeFailed: false,
        fetchFailed: false,
        idbFailed: true,
        writesSkipped: false,
      }),
    ).toBe("keep");
  });

  test("keeps the cursor when the unavailable cache dropped a write that reported success", () => {
    expect(
      cursorUpdateAfterSync({
        purgeFailed: false,
        fetchFailed: false,
        idbFailed: false,
        writesSkipped: true,
      }),
    ).toBe("keep");
  });

  test("clears the cursor when the cold-path purge failed, even if everything after it succeeded", () => {
    expect(
      cursorUpdateAfterSync({
        purgeFailed: true,
        fetchFailed: false,
        idbFailed: false,
        writesSkipped: false,
      }),
    ).toBe("clear");
    expect(
      cursorUpdateAfterSync({
        purgeFailed: true,
        fetchFailed: true,
        idbFailed: true,
        writesSkipped: false,
      }),
    ).toBe("clear");
  });
});

describe("sortById", () => {
  test("orders by UTF-16 code unit, the order IndexedDB returns string keys in", () => {
    // A locale-aware compare would put "a" before "B" and "10" after "9";
    // IndexedDB does neither, and any difference rebuilds every dropdown.
    const rows = ["b", "B", "a", "9", "10"].map((id) => ({ id }));
    expect(sortById(rows, (r) => r.id).map((r) => r.id)).toEqual(["10", "9", "B", "a", "b"]);
  });

  test("leaves its input untouched", () => {
    const rows = [{ id: "b" }, { id: "a" }];
    sortById(rows, (r) => r.id);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

// Stage helpers (#839). The pure transforms are the artifact that proves the
// extraction preserved behavior: each test builds the stage's inputs by hand
// and asserts the merge the orchestrator used to do inline.
//
// Note on `oldData`: the merge helpers clone every dictionary they touch, so
// the input's dictionaries are untouched — but `Data`'s shallow `assign`
// shares the `status` object between `oldData` and the clone, so these tests
// pin dictionary behavior, not status isolation (pre-existing, out of scope).
describe("stage helpers", () => {
  const tx = (id: string, amount = 100) =>
    new Transaction({ account_id: "acc-1", transaction_id: id, amount, date: "2026-03-15" });
  const invTx = (id: string) =>
    new InvestmentTransaction({
      account_id: "acc-1",
      investment_transaction_id: id,
      amount: 50,
      date: "2026-03-15",
    });
  const split = (id: string, txId = "tx-1") =>
    new SplitTransaction({
      split_transaction_id: id,
      transaction_id: txId,
      account_id: "acc-1",
      amount: 30,
    });
  const snap = (id: string) =>
    new AccountSnapshot({ snapshot: { snapshot_id: id }, account: { account_id: "acc-1" } });
  // Mirrors `TransferDictionary.test.ts`'s fixture: the pivot reads
  // `transaction_id` off each half.
  const makePair = (
    pair_id: string,
    status: TransferPair["status"],
    transaction_ids: [string, string],
  ): TransferPair => ({
    pair_id,
    status,
    transactions: transaction_ids.map((id) => ({ transaction_id: id }) as never),
  });
  const makeRecurring = (
    recurring_id: string,
    status: Recurring["status"],
    transaction_ids: string[],
  ): Recurring => ({
    recurring_id,
    merchant_key: "m",
    merchant_name: "Merchant",
    cadence: "monthly",
    is_income: false,
    status,
    transactions: transaction_ids.map((id) => ({ transaction_id: id }) as never),
  });

  const emptyStage1 = (): Stage1Fetched => ({
    accounts: new AccountDictionary(),
    items: new ItemDictionary(),
    holdings: new HoldingDictionary(),
    budgets: new BudgetDictionary(),
    sections: new SectionDictionary(),
    categories: new CategoryDictionary(),
    charts: new ChartDictionary(),
    institutions: new InstitutionDictionary(),
    securities: new SecurityDictionary(),
    transfers: new TransferDictionary(),
    tombstonePairIds: new Set(),
    recurrings: new RecurringDictionary(),
    tombstoneRecurringIds: new Set(),
    accountsFailed: false,
    fetchFailed: false,
  });

  const emptyPartitioned = (): PartitionedFetched => ({
    transactions: {
      transactions: new TransactionDictionary(),
      investmentTransactions: new InvestmentTransactionDictionary(),
      tombstoneTxIds: new Set(),
      tombstoneInvIds: new Set(),
      networkFailed: false,
    },
    splits: {
      splitTransactions: new SplitTransactionDictionary(),
      tombstoneSplitIds: new Set(),
      networkFailed: false,
    },
    snapshots: {
      accountSnapshots: new AccountSnapshotDictionary(),
      holdingSnapshots: new HoldingSnapshotDictionary(),
      securitySnapshots: new SecuritySnapshotDictionary(),
      tombstoneAccountSnapshotIds: new Set(),
      tombstoneHoldingSnapshotIds: new Set(),
      tombstoneSecuritySnapshotIds: new Set(),
      networkFailed: false,
    },
  });

  describe("paintStage1", () => {
    test("carries the fetched non-historical stores into a fresh loading Data", () => {
      const stage1 = emptyStage1();
      const account = new Account({ account_id: "acc-1" });
      stage1.accounts.set(account.id, account);
      const budget = new Budget({ name: "Budget" });
      stage1.budgets.set(budget.id, budget);

      const painted = paintStage1(stage1);
      expect(painted.accounts).toBe(stage1.accounts);
      expect(painted.budgets).toBe(stage1.budgets);
      expect(painted.transactions.size).toBe(0);
      expect(painted.status.isInit).toBe(true);
      expect(painted.status.isLoading).toBe(true);
      expect(painted.status.isError).toBe(false);
      expect(painted.status.isColdSync).toBe(true);
    });
  });

  describe("paintCachedWarm", () => {
    test("returns the cached object itself with the loading flags set", () => {
      const cached = new Data();
      expect(paintCachedWarm(cached)).toBe(cached);
      expect(cached.status.isInit).toBe(true);
      expect(cached.status.isLoading).toBe(true);
      expect(cached.status.isError).toBe(false);
    });
  });

  describe("paintAccountsFailure", () => {
    test("cold reports a real error, warm keeps the cached paint's clean status", () => {
      const cold = paintAccountsFailure(new Data(), false);
      expect(cold.status.isInit).toBe(true);
      expect(cold.status.isLoading).toBe(false);
      expect(cold.status.isError).toBe(true);

      const warm = paintAccountsFailure(new Data(), true);
      expect(warm.status.isInit).toBe(true);
      expect(warm.status.isLoading).toBe(false);
      expect(warm.status.isError).toBe(false);
    });
  });

  describe("paintRecentWindow", () => {
    test("merges the recent window over the old state and stays mid-cold", () => {
      const oldData = new Data();
      oldData.transactions.set("tx-keep", tx("tx-keep"));
      oldData.transactions.set("tx-del", tx("tx-del"));
      oldData.splitTransactions.set("sp-keep", split("sp-keep"));

      const recent = emptyPartitioned();
      recent.transactions.transactions.set("tx-new", tx("tx-new", 200));
      recent.transactions.tombstoneTxIds.add("tx-del");
      recent.splits.splitTransactions.set("sp-new", split("sp-new"));

      const painted = paintRecentWindow(oldData, recent);
      expect([...painted.transactions.keys()].sort()).toEqual(["tx-keep", "tx-new"]);
      expect([...painted.splitTransactions.keys()].sort()).toEqual(["sp-keep", "sp-new"]);
      expect(painted.status.isInit).toBe(true);
      expect(painted.status.isLoading).toBe(true);
      expect(painted.status.isError).toBe(false);
      expect(painted.status.isColdSync).toBe(true);

      // The merge cloned before mutating: the input still holds the tombstoned row.
      expect(oldData.transactions.has("tx-del")).toBe(true);
    });
  });

  describe("applyDelta", () => {
    test("replaces Stage 1 stores wholesale and merges the partitioned delta", () => {
      const oldData = new Data();
      const oldAccount = new Account({ account_id: "acc-old" });
      oldData.accounts.set(oldAccount.id, oldAccount);
      const oldBudget = new Budget({ name: "Old" });
      oldData.budgets.set(oldBudget.id, oldBudget);
      oldData.transactions.set("tx-keep", tx("tx-keep"));
      oldData.transactions.set("tx-mod", tx("tx-mod", 100));
      oldData.transactions.set("tx-del", tx("tx-del"));
      oldData.investmentTransactions.set("inv-keep", invTx("inv-keep"));
      oldData.investmentTransactions.set("inv-del", invTx("inv-del"));
      oldData.splitTransactions.set("sp-keep", split("sp-keep"));
      oldData.splitTransactions.set("sp-del", split("sp-del"));
      oldData.accountSnapshots.set("s-keep", snap("s-keep"));
      oldData.accountSnapshots.set("s-del", snap("s-del"));
      oldData.transfers.set("p-keep", makePair("p-keep", "confirmed", ["a", "b"]));
      oldData.transfers.set("p-del", makePair("p-del", "suggested", ["c", "d"]));
      oldData.recurrings.set("r-keep", makeRecurring("r-keep", "confirmed", ["a"]));
      oldData.recurrings.set("r-del", makeRecurring("r-del", "suggested", ["b"]));

      const stage1 = emptyStage1();
      const newAccount = new Account({ account_id: "acc-new" });
      stage1.accounts.set(newAccount.id, newAccount);
      const newBudget = new Budget({ name: "New" });
      stage1.budgets.set(newBudget.id, newBudget);
      stage1.transfers.set("p-new", makePair("p-new", "suggested", ["e", "f"]));
      stage1.tombstonePairIds.add("p-del");
      stage1.recurrings.set("r-new", makeRecurring("r-new", "suggested", ["g"]));
      stage1.tombstoneRecurringIds.add("r-del");

      const partitioned = emptyPartitioned();
      partitioned.transactions.transactions.set("tx-mod", tx("tx-mod", 200));
      partitioned.transactions.transactions.set("tx-new", tx("tx-new"));
      partitioned.transactions.tombstoneTxIds.add("tx-del");
      partitioned.transactions.investmentTransactions.set("inv-new", invTx("inv-new"));
      partitioned.transactions.tombstoneInvIds.add("inv-del");
      partitioned.splits.splitTransactions.set("sp-new", split("sp-new"));
      partitioned.splits.tombstoneSplitIds.add("sp-del");
      partitioned.snapshots.accountSnapshots.set("s-new", snap("s-new"));
      partitioned.snapshots.tombstoneAccountSnapshotIds.add("s-del");

      const applied = applyDelta(oldData, stage1, partitioned);

      // Stage 1 stores replace wholesale: the old account/budget are gone.
      expect(applied.accounts).toBe(stage1.accounts);
      expect(applied.accounts.has("acc-old")).toBe(false);
      expect(applied.accounts.has("acc-new")).toBe(true);
      expect(applied.budgets).toBe(stage1.budgets);
      expect(applied.budgets.has(oldBudget.id)).toBe(false);

      // Partitioned stores merge: untouched kept, modified overwritten,
      // added set, tombstoned deleted.
      expect(applied.transactions.get("tx-keep")).toBe(oldData.transactions.get("tx-keep"));
      expect(applied.transactions.get("tx-mod")?.amount).toBe(200);
      expect(applied.transactions.has("tx-new")).toBe(true);
      expect(applied.transactions.has("tx-del")).toBe(false);
      expect(applied.investmentTransactions.has("inv-keep")).toBe(true);
      expect(applied.investmentTransactions.has("inv-new")).toBe(true);
      expect(applied.investmentTransactions.has("inv-del")).toBe(false);
      expect([...applied.splitTransactions.keys()].sort()).toEqual(["sp-keep", "sp-new"]);
      expect([...applied.accountSnapshots.keys()].sort()).toEqual(["s-keep", "s-new"]);
      expect([...applied.transfers.keys()].sort()).toEqual(["p-keep", "p-new"]);
      expect([...applied.recurrings.keys()].sort()).toEqual(["r-keep", "r-new"]);

      // The unbounded fetch commits the full history: the cold window is over.
      expect(applied.status.isInit).toBe(true);
      expect(applied.status.isLoading).toBe(false);
      expect(applied.status.isError).toBe(false);
      expect(applied.status.isColdSync).toBe(false);

      // The input is untouched: the merge cloned every dictionary it wrote.
      expect(oldData.transactions.get("tx-mod")?.amount).toBe(100);
      expect(oldData.transactions.has("tx-del")).toBe(true);
      expect(oldData.accounts.has("acc-old")).toBe(true);
      expect(oldData.accountSnapshots.has("s-del")).toBe(true);
    });
  });
});
