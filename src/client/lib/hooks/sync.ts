import { useCallback } from "react";
import { JSONInstitution, JSONSnapshotData } from "common";
import {
  BudgetsGetResponse,
  TransactionsGetResponse,
  AccountsGetResponse,
  SplitTransactionsGetResponse,
  ChartsGetResponse,
  SnapshotsGetResponse,
  SecuritiesGetResponse,
  TransfersGetResponse,
} from "server";
import {
  Account,
  InvestmentTransaction,
  Transaction,
  Budget,
  Section,
  Category,
  Item,
  SplitTransaction,
  Chart,
  AccountSnapshot,
  HoldingSnapshot,
  SecuritySnapshot,
  useAppContext,
  call,
  BudgetDictionary,
  SectionDictionary,
  CategoryDictionary,
  Data,
  TransactionDictionary,
  InvestmentTransactionDictionary,
  ItemDictionary,
  AccountDictionary,
  SplitTransactionDictionary,
  ChartDictionary,
  AccountSnapshotDictionary,
  HoldingSnapshotDictionary,
  SecuritySnapshotDictionary,
  InstitutionDictionary,
  Institution,
  useDebounce,
  indexedDb,
  StoreName,
  HoldingDictionary,
  Holding,
  SecurityDictionary,
  Security,
  TransferDictionary,
} from "client";

// Cursor key: ISO timestamp of the last successful sync's start, minus a
// safety margin. Next sync's delta fetch sends this as `start-date`, so
// the server returns only rows whose `updated >= cursor`. Cleared by
// `clean()`.
const LAST_SYNCED_CURSOR_KEY = "budget:lastSyncedCursor";

const readLastSyncedCursor = (): string | null => {
  try {
    const raw = window.localStorage.getItem(LAST_SYNCED_CURSOR_KEY);
    if (!raw) return null;
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) return null;
    // Future timestamps (clock skew between sessions) → treat as
    // missing so the next sync widens to a full fetch.
    if (t > Date.now()) return null;
    return raw;
  } catch {
    return null;
  }
};

const writeLastSyncedCursor = (cursor: string) => {
  try {
    window.localStorage.setItem(LAST_SYNCED_CURSOR_KEY, cursor);
  } catch {
    // localStorage can throw in private-mode iOS / over quota. Best
    // effort; next sync without a cursor falls through to the cold
    // path, which is correct but slower.
  }
};

const removeLastSyncedCursor = () => {
  try {
    window.localStorage.removeItem(LAST_SYNCED_CURSOR_KEY);
  } catch {
    // no-op
  }
};

// FE wall-clock minus a safety margin is the next-sync cursor. Sub-row
// `updated` timestamps aren't on every JSON wire type today, so per-row
// max(updated) can't drive the cursor without widening common/models.
// Margin trades a small per-sync re-fetch of the last minute's changes
// for robustness against client/server clock skew — a sync that picks
// `Date.now()` as the cursor would silently miss any row whose
// server-side `updated` lands behind the FE's clock view of "now".
const CURSOR_SAFETY_MARGIN_MS = 60 * 1000;
const cursorForNextSync = (syncStartedAt: Date): string =>
  new Date(syncStartedAt.getTime() - CURSOR_SAFETY_MARGIN_MS).toISOString();

/**
 * Delta payload for transactions + investment transactions: a single
 * GET `/api/transactions[?start-date=<cursor>]` carries both the
 * added/modified rows and any tombstones (`is_deleted=true`) emitted
 * since the cursor. The orchestrator applies them in-place to the
 * existing `data.transactions` / `data.investmentTransactions` via
 * `setData((old) => …)` and mirrors to IDB per row — no
 * `clearAllData → saveAllData` step. Cursor null = full fetch (cold).
 */
interface FetchTransactionsResult {
  /** Active rows arriving in the response. Constructed clients of
   *  `Transaction` / `InvestmentTransaction` ready to drop into the
   *  context dictionaries. */
  transactions: TransactionDictionary;
  investmentTransactions: InvestmentTransactionDictionary;
  /** Soft-deleted row ids — caller must `delete` from context dicts
   *  AND `indexedDb.remove(...)` per id for IDB durability. */
  tombstoneTxIds: Set<string>;
  tombstoneInvIds: Set<string>;
  networkFailed: boolean;
}

const fetchTransactions = async (cursor: string | null): Promise<FetchTransactionsResult> => {
  const result: FetchTransactionsResult = {
    transactions: new TransactionDictionary(),
    investmentTransactions: new InvestmentTransactionDictionary(),
    tombstoneTxIds: new Set(),
    tombstoneInvIds: new Set(),
    networkFailed: false,
  };

  const params = new URLSearchParams();
  if (cursor) params.append("start-date", cursor);
  // Route hardcodes `includeDeleted: true`; soft-deleted rows arrive
  // as tombstones (is_deleted=true).
  const path = `/api/transactions${params.toString() ? "?" + params.toString() : ""}`;
  const response = await call.get<TransactionsGetResponse>(path).catch(console.error);
  if (!response || response.status === "error") {
    result.networkFailed = true;
    return result;
  }
  if (!response.body) return result;

  const { transactions, investmentTransactions } = response.body;
  transactions.forEach((t) => {
    if (t.is_deleted) {
      result.tombstoneTxIds.add(t.transaction_id);
      return;
    }
    result.transactions.set(t.transaction_id, new Transaction(t));
  });
  investmentTransactions.forEach((t) => {
    if (t.is_deleted) {
      result.tombstoneInvIds.add(t.investment_transaction_id);
      return;
    }
    result.investmentTransactions.set(t.investment_transaction_id, new InvestmentTransaction(t));
  });

  return result;
};

interface FetchSplitTransactionsResult {
  splitTransactions: SplitTransactionDictionary;
  tombstoneSplitIds: Set<string>;
  networkFailed: boolean;
}

const fetchSplitTransactions = async (
  cursor: string | null,
): Promise<FetchSplitTransactionsResult> => {
  const result: FetchSplitTransactionsResult = {
    splitTransactions: new SplitTransactionDictionary(),
    tombstoneSplitIds: new Set(),
    networkFailed: false,
  };

  const params = new URLSearchParams();
  if (cursor) params.append("start-date", cursor);
  const path = `/api/split-transactions${params.toString() ? "?" + params.toString() : ""}`;

  const response = await call.get<SplitTransactionsGetResponse>(path).catch(console.error);
  if (!response || response.status === "error") {
    result.networkFailed = true;
    return result;
  }
  if (!response.body) return result;

  response.body.forEach((t) => {
    if (t.is_deleted) {
      result.tombstoneSplitIds.add(t.split_transaction_id);
      return;
    }
    result.splitTransactions.set(t.split_transaction_id, new SplitTransaction(t));
  });

  return result;
};

interface FetchAccountsResult {
  accounts: AccountDictionary;
  items: ItemDictionary;
  holdings: HoldingDictionary;
  networkFailed: boolean;
}

const fetchAccounts = async (): Promise<FetchAccountsResult> => {
  const result = {
    accounts: new AccountDictionary(),
    items: new ItemDictionary(),
    holdings: new HoldingDictionary(),
    networkFailed: false,
  };

  const response = await call.get<AccountsGetResponse>("/api/accounts").catch(console.error);
  if (response?.status === "error") return { ...result, networkFailed: true };
  if (!response?.body) return result;

  const { accounts, items, holdings } = response.body;

  accounts.forEach((e) => result.accounts.set(e.account_id, new Account(e)));
  items.forEach((item) => result.items.set(item.item_id, new Item(item)));
  holdings.forEach((h) => result.holdings.set(h.holding_id, new Holding(h)));

  return result;
};

interface FetchBudgetsResult {
  budgets: BudgetDictionary;
  sections: SectionDictionary;
  categories: CategoryDictionary;
  networkFailed: boolean;
}

const fetchBudgets = async (): Promise<FetchBudgetsResult> => {
  const result: FetchBudgetsResult = {
    budgets: new BudgetDictionary(),
    sections: new SectionDictionary(),
    categories: new CategoryDictionary(),
    networkFailed: false,
  };

  const response = await call.get<BudgetsGetResponse>("/api/budgets").catch(console.error);
  if (!response || response.status === "error") {
    result.networkFailed = true;
    return result;
  }
  if (!response.body) return result;

  const { budgets, sections, categories } = response.body;
  budgets.forEach((e) => result.budgets.set(e.budget_id, new Budget(e)));
  sections.forEach((e) => result.sections.set(e.section_id, new Section(e)));
  categories.forEach((e) => result.categories.set(e.category_id, new Category(e)));

  return result;
};

interface FetchTransfersResult {
  transfers: TransferDictionary;
  networkFailed: boolean;
}

/**
 * Lightweight fetch of all transfer pairs for the user. Lives in
 * useSync alongside the other model fetches so a cold/warm load
 * paints with pair state already in place. Returns a single
 * TransferDictionary (pair_id → TransferPair) — consumers resolve
 * transaction_id lookups via `transfers.getByTransactionId(id)` which
 * is O(1) over the dictionary's internal pivot map. Mutation methods
 * in `useTransfers` update `data.transfers` in-place via `setData`
 * (no re-fetch on mutation).
 */
const fetchTransfers = async (): Promise<FetchTransfersResult> => {
  const result: FetchTransfersResult = {
    transfers: new TransferDictionary(),
    networkFailed: false,
  };

  const response = await call.get<TransfersGetResponse>("/api/transfers").catch(console.error);
  if (!response || response.status === "error") {
    result.networkFailed = true;
    return result;
  }
  if (!response.body) return result;

  for (const pair of response.body) {
    result.transfers.set(pair.pair_id, pair);
  }

  return result;
};

interface FetchSnapshotsResult {
  accountSnapshots: AccountSnapshotDictionary;
  holdingSnapshots: HoldingSnapshotDictionary;
  securitySnapshots: SecuritySnapshotDictionary;
  networkFailed: boolean;
}

interface FetchSnapshotsResultDelta extends FetchSnapshotsResult {
  tombstoneAccountSnapshotIds: Set<string>;
  tombstoneHoldingSnapshotIds: Set<string>;
  tombstoneSecuritySnapshotIds: Set<string>;
}

const fetchSnapshots = async (
  accounts: AccountDictionary,
  cursor: string | null,
): Promise<FetchSnapshotsResultDelta> => {
  const result: FetchSnapshotsResultDelta = {
    accountSnapshots: new AccountSnapshotDictionary(),
    holdingSnapshots: new HoldingSnapshotDictionary(),
    securitySnapshots: new SecuritySnapshotDictionary(),
    tombstoneAccountSnapshotIds: new Set(),
    tombstoneHoldingSnapshotIds: new Set(),
    tombstoneSecuritySnapshotIds: new Set(),
    networkFailed: false,
  };

  // Single GET against `/api/snapshots[?start-date=<cursor>]`. The
  // route's `searchSnapshots` returns user-scoped account+holding
  // snapshots (no `account-id` narrow) PLUS shared security snapshots
  // in one response — same superset previously hand-stitched
  // per-account-per-month with shared security as a separate fetch
  // per month.
  const params = new URLSearchParams();
  if (cursor) params.append("start-date", cursor);
  const path = `/api/snapshots${params.toString() ? "?" + params.toString() : ""}`;
  const response = await call.get<SnapshotsGetResponse>(path).catch(console.error);
  if (!response || response.status === "error") {
    result.networkFailed = true;
    return result;
  }
  if (!response.body) return result;

  response.body.forEach((snapshot: JSONSnapshotData) => {
    if (snapshot.snapshot.is_deleted) {
      const id = snapshot.snapshot.snapshot_id;
      if ("account" in snapshot) result.tombstoneAccountSnapshotIds.add(id);
      else if ("holding" in snapshot) result.tombstoneHoldingSnapshotIds.add(id);
      else if ("security" in snapshot) result.tombstoneSecuritySnapshotIds.add(id);
      return;
    }
    if ("account" in snapshot) {
      const account = accounts.get(snapshot.account.account_id) || {};
      snapshot.account = { ...account, ...snapshot.account };
      const newSnapshot = new AccountSnapshot(snapshot);
      result.accountSnapshots.set(newSnapshot.snapshot.id, newSnapshot);
    } else if ("holding" in snapshot) {
      const newSnapshot = new HoldingSnapshot(snapshot);
      result.holdingSnapshots.set(newSnapshot.snapshot.id, newSnapshot);
    } else if ("security" in snapshot) {
      const newSnapshot = new SecuritySnapshot(snapshot);
      result.securitySnapshots.set(newSnapshot.snapshot.id, newSnapshot);
    }
  });

  return result;
};

interface FetchChartsResult {
  charts: ChartDictionary;
  networkFailed: boolean;
}

const fetchCharts = async (): Promise<FetchChartsResult> => {
  const result: FetchChartsResult = {
    charts: new ChartDictionary(),
    networkFailed: false,
  };
  const response = await call.get<ChartsGetResponse>("/api/charts").catch(console.error);
  if (!response || response.status === "error") {
    result.networkFailed = true;
    return result;
  }
  response.body?.forEach((e) => result.charts.set(e.chart_id, new Chart(e)));
  return result;
};

interface FetchInstitutionResult {
  institutions: InstitutionDictionary;
  networkFailed: boolean;
}

const fetchInstitutions = async (accounts: AccountDictionary): Promise<FetchInstitutionResult> => {
  const result: FetchInstitutionResult = {
    institutions: new InstitutionDictionary(),
    networkFailed: false,
  };
  const promises = accounts.toArray().map(async ({ institution_id }) => {
    if (institution_id === "Unknown") return;
    const response = await call
      .get<JSONInstitution>(`/api/institution?id=${institution_id}`)
      .catch(console.error);
    if (!response || response.status === "error") {
      result.networkFailed = true;
      return;
    }
    result.institutions.set(institution_id, new Institution(response.body));
  });

  await Promise.all(promises);

  return result;
};

interface FetchSecuritiesResult {
  securities: SecurityDictionary;
  networkFailed: boolean;
}

const fetchSecurities = async (): Promise<FetchSecuritiesResult> => {
  const result: FetchSecuritiesResult = {
    securities: new SecurityDictionary(),
    networkFailed: false,
  };
  const response = await call.get<SecuritiesGetResponse>("/api/securities").catch(console.error);
  if (!response || response.status === "error") {
    result.networkFailed = true;
    return result;
  }
  response.body?.forEach((s) => {
    if (s.security_id) result.securities.set(s.security_id, new Security(s));
  });
  return result;
};

export const useSync = () => {
  const { user, setData } = useAppContext();
  const debouncer = useDebounce();
  const _sync = useCallback(async () => {
    if (!user) return;
    setData((oldData) => {
      const newData = new Data(oldData);
      newData.status.isLoading = true;
      return newData;
    });

    try {
      // Snapshot the wall-clock at sync start. Used to compute the next
      // cursor *if* every fetch succeeds, so a failed sync doesn't
      // advance the cursor and miss the rows that landed during the
      // failed window. Captured here, not at the end, so concurrent
      // server-side writes between start and end are picked up by the
      // next sync (which uses cursor = startedAt - safety margin).
      const syncStartedAt = new Date();

      const cached = await indexedDb.loadAllData().catch((err) => {
        console.error(err);
        return null;
      });
      const cursor = readLastSyncedCursor();
      // Warm vs cold is gated on BOTH: a populated IDB cache AND a
      // previously-recorded cursor. Either missing → cold (full fetch,
      // no cursor on the wire).
      const isWarm = !!cached && cached.accounts.size > 0 && cursor !== null;

      // ===== Stage 1: non-historical data (cheap, paints fast). =====
      // Accounts/items, budgets/sections/categories, charts,
      // institutions, securities, transfers. None of these are
      // time-partitioned. Refreshed on every sync (warm + cold).
      //
      // For warm load, we paint cached state first so the UI doesn't
      // flicker between cache and the refreshed view of Stage 1.
      if (isWarm && cached) {
        cached.status.isInit = true;
        cached.status.isLoading = true;
        cached.status.isError = false;
        setData(cached);
      }

      const accountsPromise = fetchAccounts();
      const { networkFailed: accountsFailed } = await accountsPromise;

      if (accountsFailed) {
        if (isWarm && cached) {
          // Offline / server down on a warm load — keep painted cache,
          // clear the loading flag.
          cached.status.isInit = true;
          cached.status.isLoading = false;
          cached.status.isError = false;
          setData(cached);
        } else {
          setData((oldData) => {
            const newData = new Data(oldData);
            newData.status.isInit = true;
            newData.status.isLoading = false;
            newData.status.isError = true;
            return newData;
          });
        }
        return;
      }

      const { accounts, items, holdings } = await accountsPromise;

      const [
        stage1Budgets,
        stage1Charts,
        stage1Institutions,
        stage1Securities,
        stage1Transfers,
      ] = await Promise.all([
        fetchBudgets(),
        fetchCharts(),
        fetchInstitutions(accounts),
        fetchSecurities(),
        fetchTransfers(),
      ]);
      const { budgets, sections, categories } = stage1Budgets;
      const { charts } = stage1Charts;
      const { institutions } = stage1Institutions;
      const { securities } = stage1Securities;
      const { transfers } = stage1Transfers;

      // On a cold load, paint Stage 1 immediately so the navigation +
      // summary widgets render before the historical fetches finish.
      // On warm load, the cached paint above already covered this; the
      // delta apply below replaces what changed.
      if (!isWarm) {
        const stage1 = new Data({
          accounts,
          items,
          holdings,
          budgets,
          sections,
          categories,
          charts,
          institutions,
          securities,
          transfers,
        });
        stage1.status.isInit = true;
        stage1.status.isLoading = true;
        stage1.status.isError = false;
        setData(stage1);
      }

      // ===== Stage 2: time-partitioned stores via delta fetch. =====
      // Cursor null on cold → single full GET per store. Cursor set on
      // warm → server returns only rows whose `updated >= cursor`. The
      // route filter is inclusive; cursor includes a safety margin so
      // borderline rows aren't missed at the cost of a small per-sync
      // re-fetch of the last minute's changes.
      const [
        transactionsResult,
        splitTransactionsResult,
        snapshotsResult,
      ] = await Promise.all([
        fetchTransactions(cursor),
        fetchSplitTransactions(cursor),
        fetchSnapshots(accounts, cursor),
      ]);

      // ===== Stage 3: apply (warm path: in-place merge on `oldData`;
      //                       cold path: drop into a fresh Data). =====
      //
      // Warm: existing state stays — added/modified rows overwrite their
      // ids in the cloned dictionary; tombstoned ids are explicitly
      // deleted from the clone. This is the design-doc rule (the calc
      // depends on prior state, so the orchestrator can't just `new
      // Data(refreshed)`).
      //
      // Cold: no prior state to merge with; the delta result IS the
      // full data.
      setData((oldData) => {
        const base = isWarm && oldData.accounts.size > 0 ? oldData : new Data();

        const next = new Data(base);
        next.accounts = accounts;
        next.holdings = holdings;
        next.items = items;
        next.budgets = budgets;
        next.sections = sections;
        next.categories = categories;
        next.charts = charts;
        next.institutions = institutions;
        next.securities = securities;
        next.transfers = transfers;

        // Apply transactions delta: clone the existing dict, set
        // added/modified, delete tombstoned ids.
        next.transactions = new TransactionDictionary(base.transactions);
        transactionsResult.transactions.forEach((t, id) => next.transactions.set(id, t));
        transactionsResult.tombstoneTxIds.forEach((id) => next.transactions.delete(id));

        next.investmentTransactions = new InvestmentTransactionDictionary(
          base.investmentTransactions,
        );
        transactionsResult.investmentTransactions.forEach((t, id) =>
          next.investmentTransactions.set(id, t),
        );
        transactionsResult.tombstoneInvIds.forEach((id) =>
          next.investmentTransactions.delete(id),
        );

        next.splitTransactions = new SplitTransactionDictionary(base.splitTransactions);
        splitTransactionsResult.splitTransactions.forEach((t, id) =>
          next.splitTransactions.set(id, t),
        );
        splitTransactionsResult.tombstoneSplitIds.forEach((id) =>
          next.splitTransactions.delete(id),
        );

        next.accountSnapshots = new AccountSnapshotDictionary(base.accountSnapshots);
        snapshotsResult.accountSnapshots.forEach((s, id) => next.accountSnapshots.set(id, s));
        snapshotsResult.tombstoneAccountSnapshotIds.forEach((id) =>
          next.accountSnapshots.delete(id),
        );

        next.holdingSnapshots = new HoldingSnapshotDictionary(base.holdingSnapshots);
        snapshotsResult.holdingSnapshots.forEach((s, id) => next.holdingSnapshots.set(id, s));
        snapshotsResult.tombstoneHoldingSnapshotIds.forEach((id) =>
          next.holdingSnapshots.delete(id),
        );

        next.securitySnapshots = new SecuritySnapshotDictionary(base.securitySnapshots);
        snapshotsResult.securitySnapshots.forEach((s, id) => next.securitySnapshots.set(id, s));
        snapshotsResult.tombstoneSecuritySnapshotIds.forEach((id) =>
          next.securitySnapshots.delete(id),
        );

        next.status.isInit = true;
        next.status.isLoading = false;
        next.status.isError = false;
        return next;
      });

      // ===== Stage 4: persist + advance the cursor. =====
      //
      // Per-store batched `saveMany` writes for added/modified entries
      // and per-row `remove` for tombstones. AWAITED so the cursor
      // write at the end happens AFTER IDB is durable — a page reload
      // right after sync sees the same state the cursor advertises.
      // (Fire-and-forget here would race the next warm boot's
      // `loadAllData` against the in-flight writes; the test that
      // surfaced this caught a partial cold-sync state being treated
      // as the warm-load baseline.)
      const refreshedStage1 = new Data({
        accounts,
        items,
        holdings,
        budgets,
        sections,
        categories,
        charts,
        institutions,
        securities,
        transfers,
      });
      await Promise.all([
        indexedDb.saveAllData(refreshedStage1),
        indexedDb.saveTransactions(transactionsResult.transactions),
        indexedDb.saveInvestmentTransactions(transactionsResult.investmentTransactions),
        indexedDb.saveSplitTransactions(splitTransactionsResult.splitTransactions),
        indexedDb.saveAccountSnapshots(snapshotsResult.accountSnapshots),
        indexedDb.saveHoldingSnapshots(snapshotsResult.holdingSnapshots),
        indexedDb.saveSecuritySnapshots(snapshotsResult.securitySnapshots),
      ]).catch(console.error);

      // Tombstones: per-row remove. Small N (typically 0–few), so the
      // serial overhead is negligible and there's no batched-remove
      // helper. Awaited via Promise.all alongside the saves above
      // would mix store transactions; keep separate for clarity.
      const tombstoneRemovals: Promise<void>[] = [];
      transactionsResult.tombstoneTxIds.forEach((id) => {
        tombstoneRemovals.push(indexedDb.remove(StoreName.transactions, id));
      });
      transactionsResult.tombstoneInvIds.forEach((id) => {
        tombstoneRemovals.push(indexedDb.remove(StoreName.investmentTransactions, id));
      });
      splitTransactionsResult.tombstoneSplitIds.forEach((id) => {
        tombstoneRemovals.push(indexedDb.remove(StoreName.splitTransactions, id));
      });
      snapshotsResult.tombstoneAccountSnapshotIds.forEach((id) => {
        tombstoneRemovals.push(indexedDb.remove(StoreName.accountSnapshots, id));
      });
      snapshotsResult.tombstoneHoldingSnapshotIds.forEach((id) => {
        tombstoneRemovals.push(indexedDb.remove(StoreName.holdingSnapshots, id));
      });
      snapshotsResult.tombstoneSecuritySnapshotIds.forEach((id) => {
        tombstoneRemovals.push(indexedDb.remove(StoreName.securitySnapshots, id));
      });
      await Promise.all(tombstoneRemovals).catch(console.error);

      // Cursor advances ONLY if every fetch succeeded. On any failure,
      // leave the cursor at its previous value so the next sync's delta
      // still spans the gap that just failed.
      const fetchFailed =
        stage1Budgets.networkFailed ||
        stage1Charts.networkFailed ||
        stage1Institutions.networkFailed ||
        stage1Securities.networkFailed ||
        stage1Transfers.networkFailed ||
        transactionsResult.networkFailed ||
        splitTransactionsResult.networkFailed ||
        snapshotsResult.networkFailed;

      if (!fetchFailed) {
        writeLastSyncedCursor(cursorForNextSync(syncStartedAt));
      }
    } catch (err) {
      console.error(err);
      setData((oldData) => {
        const newData = new Data(oldData);
        newData.status.isInit = true;
        newData.status.isLoading = false;
        newData.status.isError = true;
        return newData;
      });
    }
  }, [setData, user]);

  const sync = useCallback(() => debouncer(_sync), [_sync, debouncer]);

  const clean = useCallback(() => {
    indexedDb.clearAllData();
    removeLastSyncedCursor();
    setData(new Data());
  }, [setData]);

  return { sync, clean };
};
