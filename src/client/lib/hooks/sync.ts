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
// Old localStorage key (pre-delta-sync). Removed on first load below
// so returning users don't carry the dead key forever.
const LEGACY_LAST_SYNCED_AT_KEY = "budget:lastSyncedAt";

const dropLegacyKeys = () => {
  try {
    window.localStorage.removeItem(LEGACY_LAST_SYNCED_AT_KEY);
  } catch {
    // no-op
  }
};

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
  tombstoneAccountSnapshotIds: Set<string>;
  tombstoneHoldingSnapshotIds: Set<string>;
  tombstoneSecuritySnapshotIds: Set<string>;
  networkFailed: boolean;
}

const fetchSnapshots = async (
  accounts: AccountDictionary,
  cursor: string | null,
): Promise<FetchSnapshotsResult> => {
  const result: FetchSnapshotsResult = {
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
  // in one response.
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
      dropLegacyKeys();

      const cached = await indexedDb.loadAllData().catch((err) => {
        console.error(err);
        return null;
      });
      const cursorRaw = readLastSyncedCursor();
      // Warm vs cold is gated on:
      //   - a populated IDB cache (accounts AND at least one
      //     time-partitioned store; protects against partial-IDB
      //     states like a future schema migration that resets some
      //     stores or storage-quota partial eviction), AND
      //   - a previously-recorded cursor.
      // Any missing → cold (full fetch, no cursor on the wire) so
      // the time-partitioned history can re-hydrate from scratch.
      const isWarm =
        !!cached &&
        cached.accounts.size > 0 &&
        (cached.transactions.size > 0 ||
          cached.investmentTransactions.size > 0 ||
          cached.accountSnapshots.size > 0) &&
        cursorRaw !== null;

      // Cold path purges IDB before the new save block writes the
      // fresh delta — otherwise pre-tombstone-era rows (soft-deleted
      // server-side before tombstone delivery existed, hard-deleted,
      // or admin-removed) persist as cruft. Without a cursor the
      // server's delta won't replay tombstones for those, so cold is
      // the only opportunity to reset IDB. Awaited — the new saves
      // can't safely race against a still-in-flight clearAllData on
      // the same stores.
      if (!isWarm) {
        await indexedDb.clearAllData().catch(console.error);
      }
      // Pass the cursor to delta fetches ONLY on the warm branch. The
      // cold path must fetch the full history with no `start-date=` —
      // if localStorage has a stale cursor (IDB cleared by quota /
      // DevTools, or `clean()`'s clearAllData racing the next sync),
      // sending the cursor would return only rows updated since it
      // and the reducer's empty-base would commit a near-empty
      // dataset to React state.
      const cursor = isWarm ? cursorRaw : null;

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

      // Kick off every Stage 1 fetch in parallel. Only `fetchInstitutions`
      // depends on accounts (chained via the promise), the rest are
      // independent and start as soon as the user is authenticated.
      const accountsPromise = fetchAccounts();
      const budgetsPromise = fetchBudgets();
      const chartsPromise = fetchCharts();
      const institutionsPromise = accountsPromise.then((r) => fetchInstitutions(r.accounts));
      const securitiesPromise = fetchSecurities();
      const transfersPromise = fetchTransfers();

      const [
        accountsResult,
        stage1Budgets,
        stage1Charts,
        stage1Institutions,
        stage1Securities,
        stage1Transfers,
      ] = await Promise.all([
        accountsPromise,
        budgetsPromise,
        chartsPromise,
        institutionsPromise,
        securitiesPromise,
        transfersPromise,
      ]);

      if (accountsResult.networkFailed) {
        // Setdata via the updater so React sees a distinct reference
        // and commits; the warm-path paint above already committed the
        // same `cached` ref, so `setData(cached)` would Object.is-bail
        // and strand the loading flag.
        setData((oldData) => {
          const newData = new Data(oldData);
          newData.status.isInit = true;
          newData.status.isLoading = false;
          newData.status.isError = !isWarm; // online cache wins; cold = real error
          return newData;
        });
        return;
      }

      const { accounts, items, holdings } = accountsResult;
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

      // ===== Stage 2: cold-only recent-window paint. =====
      // The unbounded fetch below scales with the user's full history
      // (3s for ~6k transactions, more for larger sets). To keep the
      // first-historical paint fast on cold load, fetch the recent 2
      // months first via `start-date=<2-months-ago>` and paint that
      // window. The unbounded Stage 3 fetch fills in older months
      // after. On warm load this is skipped — the cached paint
      // already covered it.
      if (!isWarm) {
        const twoMonthsAgo = new Date(
          syncStartedAt.getTime() - 60 * 24 * 60 * 60 * 1000,
        ).toISOString();
        const [recentTx, recentSplits, recentSnaps] = await Promise.all([
          fetchTransactions(twoMonthsAgo),
          fetchSplitTransactions(twoMonthsAgo),
          fetchSnapshots(accounts, twoMonthsAgo),
        ]);
        setData((oldData) => {
          const next = new Data(oldData);
          next.transactions = new TransactionDictionary(oldData.transactions);
          recentTx.transactions.forEach((t, id) => next.transactions.set(id, t));
          recentTx.tombstoneTxIds.forEach((id) => next.transactions.delete(id));
          next.investmentTransactions = new InvestmentTransactionDictionary(
            oldData.investmentTransactions,
          );
          recentTx.investmentTransactions.forEach((t, id) =>
            next.investmentTransactions.set(id, t),
          );
          recentTx.tombstoneInvIds.forEach((id) => next.investmentTransactions.delete(id));
          next.splitTransactions = new SplitTransactionDictionary(oldData.splitTransactions);
          recentSplits.splitTransactions.forEach((t, id) =>
            next.splitTransactions.set(id, t),
          );
          recentSplits.tombstoneSplitIds.forEach((id) => next.splitTransactions.delete(id));
          next.accountSnapshots = new AccountSnapshotDictionary(oldData.accountSnapshots);
          recentSnaps.accountSnapshots.forEach((s, id) => next.accountSnapshots.set(id, s));
          recentSnaps.tombstoneAccountSnapshotIds.forEach((id) =>
            next.accountSnapshots.delete(id),
          );
          next.holdingSnapshots = new HoldingSnapshotDictionary(oldData.holdingSnapshots);
          recentSnaps.holdingSnapshots.forEach((s, id) => next.holdingSnapshots.set(id, s));
          recentSnaps.tombstoneHoldingSnapshotIds.forEach((id) =>
            next.holdingSnapshots.delete(id),
          );
          next.securitySnapshots = new SecuritySnapshotDictionary(oldData.securitySnapshots);
          recentSnaps.securitySnapshots.forEach((s, id) => next.securitySnapshots.set(id, s));
          recentSnaps.tombstoneSecuritySnapshotIds.forEach((id) =>
            next.securitySnapshots.delete(id),
          );
          next.status.isInit = true;
          next.status.isLoading = true;
          next.status.isError = false;
          return next;
        });
      }

      // ===== Stage 3: time-partitioned stores via delta/full fetch. =====
      // Cursor null on cold → unbounded GET (fills in older months
      // after Stage 2 painted recent ones). Cursor set on warm →
      // server returns only rows whose `updated >= cursor`. The route
      // filter is inclusive; cursor includes a safety margin so
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

      // ===== Stage 4: apply (warm + cold: in-place merge on `oldData`). =====
      //
      // Existing state stays — added/modified rows overwrite their
      // ids in the cloned dictionary; tombstoned ids are explicitly
      // deleted from the clone. This is the design-doc rule (the calc
      // depends on prior state, so the orchestrator can't just `new
      // Data(refreshed)`).
      //
      // On cold load, the prior state from Stage 2's recent-window
      // paint is already in oldData; Stage 4's unbounded fetch
      // overlays the same recent rows (idempotent) and fills in the
      // older months.
      setData((oldData) => {
        const next = new Data(oldData);
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
        next.transactions = new TransactionDictionary(oldData.transactions);
        transactionsResult.transactions.forEach((t, id) => next.transactions.set(id, t));
        transactionsResult.tombstoneTxIds.forEach((id) => next.transactions.delete(id));

        next.investmentTransactions = new InvestmentTransactionDictionary(
          oldData.investmentTransactions,
        );
        transactionsResult.investmentTransactions.forEach((t, id) =>
          next.investmentTransactions.set(id, t),
        );
        transactionsResult.tombstoneInvIds.forEach((id) =>
          next.investmentTransactions.delete(id),
        );

        next.splitTransactions = new SplitTransactionDictionary(oldData.splitTransactions);
        splitTransactionsResult.splitTransactions.forEach((t, id) =>
          next.splitTransactions.set(id, t),
        );
        splitTransactionsResult.tombstoneSplitIds.forEach((id) =>
          next.splitTransactions.delete(id),
        );

        next.accountSnapshots = new AccountSnapshotDictionary(oldData.accountSnapshots);
        snapshotsResult.accountSnapshots.forEach((s, id) => next.accountSnapshots.set(id, s));
        snapshotsResult.tombstoneAccountSnapshotIds.forEach((id) =>
          next.accountSnapshots.delete(id),
        );

        next.holdingSnapshots = new HoldingSnapshotDictionary(oldData.holdingSnapshots);
        snapshotsResult.holdingSnapshots.forEach((s, id) => next.holdingSnapshots.set(id, s));
        snapshotsResult.tombstoneHoldingSnapshotIds.forEach((id) =>
          next.holdingSnapshots.delete(id),
        );

        next.securitySnapshots = new SecuritySnapshotDictionary(oldData.securitySnapshots);
        snapshotsResult.securitySnapshots.forEach((s, id) => next.securitySnapshots.set(id, s));
        snapshotsResult.tombstoneSecuritySnapshotIds.forEach((id) =>
          next.securitySnapshots.delete(id),
        );

        next.status.isInit = true;
        next.status.isLoading = false;
        next.status.isError = false;
        return next;
      });

      // ===== Stage 5: persist + advance the cursor. =====
      //
      // Per-store batched `saveMany` writes for added/modified entries
      // and per-row `remove` for tombstones. AWAITED so the cursor
      // write at the end happens AFTER IDB is durable — a page reload
      // right after sync sees the same state the cursor advertises.
      // Cursor advances ONLY if every fetch AND every IDB write
      // succeeded. A swallowed IDB save error here used to silently
      // advance the cursor — the failed row stayed in React state but
      // never landed in IDB; once the 60s cursor margin elapsed, the
      // server stopped re-emitting it (`WHERE updated >= cursor` was
      // inclusive of the last sync's window only). On next page reload
      // `loadAllData` painted the prior IDB cache without the row, and
      // it was permanently gone. So track IDB outcomes too and gate
      // the cursor on both.
      const fetchFailed =
        stage1Budgets.networkFailed ||
        stage1Charts.networkFailed ||
        stage1Institutions.networkFailed ||
        stage1Securities.networkFailed ||
        stage1Transfers.networkFailed ||
        transactionsResult.networkFailed ||
        splitTransactionsResult.networkFailed ||
        snapshotsResult.networkFailed;

      // Non-time-partitioned stores: explicit per-store saves (avoids
      // `saveAllData`'s 6 empty-dict transactions). Time-partitioned
      // stores save the delta dict — the previous-sync state for any
      // row that wasn't in this delta is already on disk from the
      // sync that fetched it (idempotent per-id put).
      const idbSaves: Promise<void>[] = [
        indexedDb.saveAccounts(accounts),
        indexedDb.saveHoldings(holdings),
        indexedDb.saveItems(items),
        indexedDb.saveBudgets(budgets),
        indexedDb.saveSections(sections),
        indexedDb.saveCategories(categories),
        indexedDb.saveCharts(charts),
        indexedDb.saveInstitutions(institutions),
        indexedDb.saveSecurities(securities),
        indexedDb.saveTransfers(transfers),
        indexedDb.saveTransactions(transactionsResult.transactions),
        indexedDb.saveInvestmentTransactions(transactionsResult.investmentTransactions),
        indexedDb.saveSplitTransactions(splitTransactionsResult.splitTransactions),
        indexedDb.saveAccountSnapshots(snapshotsResult.accountSnapshots),
        indexedDb.saveHoldingSnapshots(snapshotsResult.holdingSnapshots),
        indexedDb.saveSecuritySnapshots(snapshotsResult.securitySnapshots),
      ];
      transactionsResult.tombstoneTxIds.forEach((id) => {
        idbSaves.push(indexedDb.remove(StoreName.transactions, id));
      });
      transactionsResult.tombstoneInvIds.forEach((id) => {
        idbSaves.push(indexedDb.remove(StoreName.investmentTransactions, id));
      });
      splitTransactionsResult.tombstoneSplitIds.forEach((id) => {
        idbSaves.push(indexedDb.remove(StoreName.splitTransactions, id));
      });
      snapshotsResult.tombstoneAccountSnapshotIds.forEach((id) => {
        idbSaves.push(indexedDb.remove(StoreName.accountSnapshots, id));
      });
      snapshotsResult.tombstoneHoldingSnapshotIds.forEach((id) => {
        idbSaves.push(indexedDb.remove(StoreName.holdingSnapshots, id));
      });
      snapshotsResult.tombstoneSecuritySnapshotIds.forEach((id) => {
        idbSaves.push(indexedDb.remove(StoreName.securitySnapshots, id));
      });

      // `allSettled` rather than `all`: a partial IDB failure
      // shouldn't tear down the orchestrator (React state already has
      // the data); we just need to detect the failure so the cursor
      // stays put and the next sync re-fetches the delta.
      const idbOutcomes = await Promise.allSettled(idbSaves);
      const idbFailed = idbOutcomes.some((o) => {
        if (o.status === "rejected") {
          console.error("[useSync] IDB persist failed:", o.reason);
          return true;
        }
        return false;
      });

      if (!fetchFailed && !idbFailed) {
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
