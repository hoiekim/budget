import { useCallback } from "react";
import { JSONSnapshotData, TableName } from "common";
import {
  BudgetsGetResponse,
  TransactionsGetResponse,
  AccountsGetResponse,
  SplitTransactionsGetResponse,
  ChartsGetResponse,
  SnapshotsGetResponse,
  SecuritiesGetResponse,
  TransfersGetResponse,
  RecurringsGetResponse,
  InstitutionsGetResponse,
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
  indexedDb,
  StoreName,
  HoldingDictionary,
  Holding,
  SecurityDictionary,
  Security,
  TransferDictionary,
  RecurringDictionary,
  globalData,
} from "client";
// Straight from the module rather than the barrel, so it is initialised when
// this module's top level runs.
import { indexedDbAccessor } from "client/lib/indexed-db/accessor";

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

// Stores an upgrade creates start empty, so no cursor from before it can seed
// a delta for them. Set at load, before anything on the page opens the cache.
indexedDbAccessor.onUpgradeExisting = removeLastSyncedCursor;

/**
 * What a finished sync does with the delta cursor. A failed fetch or save, or a
 * write the unavailable cache dropped, keeps it so the next sync re-fetches the
 * same delta. A failed cold-path purge clears it: hard-deleted rows never
 * arrive as tombstones, so only another cold sync can evict what the failed
 * purge left behind.
 */
export const cursorUpdateAfterSync = (outcome: {
  purgeFailed: boolean;
  fetchFailed: boolean;
  idbFailed: boolean;
  writesSkipped: boolean;
}): "advance" | "clear" | "keep" => {
  if (outcome.purgeFailed) return "clear";
  if (outcome.fetchFailed || outcome.idbFailed || outcome.writesSkipped) return "keep";
  return "advance";
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

export const sortById = <T,>(rows: T[], id: (row: T) => string): T[] =>
  [...rows].sort((a, b) => (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0));

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

  // Id order is the order IndexedDB hands the cache back in. Matching it keeps
  // every budget/category dropdown from being rebuilt when a warm load's
  // cached paint is replaced by the network's.
  const { budgets, sections, categories } = response.body;
  sortById(budgets, (e) => e.budget_id).forEach((e) =>
    result.budgets.set(e.budget_id, new Budget(e)),
  );
  sortById(sections, (e) => e.section_id).forEach((e) =>
    result.sections.set(e.section_id, new Section(e)),
  );
  sortById(categories, (e) => e.category_id).forEach((e) =>
    result.categories.set(e.category_id, new Category(e)),
  );

  return result;
};

interface FetchTransfersResult {
  transfers: TransferDictionary;
  /** Pair ids the server sent as eviction signals — caller must `delete`
   *  from the context dictionary AND `indexedDb.remove(...)` per id. */
  tombstonePairIds: Set<string>;
  networkFailed: boolean;
}

/**
 * Delta fetch of transfer pairs. Consumers resolve transaction_id
 * lookups via `transfers.byTransactionId.get(id)` (and the
 * `has`/`hasSuggested`/`hasConfirmed` membership predicates), each O(1)
 * over the dictionary's internal pivot map. Mutation methods in
 * `useTransfers` update `data.transfers` in-place via `setData` (no
 * re-fetch on mutation).
 *
 * A pair leaves the view by being soft-deleted, rejected, or losing one
 * of its transactions; the server collapses all three into the same
 * wire shape — a pair with no `transactions` — so the reducer here has
 * one predicate rather than a mirror of the server's visibility rules.
 * Cursor null = full fetch (cold).
 */
const fetchTransfers = async (
  cursor: string | null,
  includeDeleted: boolean,
): Promise<FetchTransfersResult> => {
  const result: FetchTransfersResult = {
    transfers: new TransferDictionary(),
    tombstonePairIds: new Set(),
    networkFailed: false,
  };

  const params = new URLSearchParams();
  if (cursor) params.append("start-date", cursor);
  // Eviction signals only mean something when there is a cache to
  // reconcile, which is the caller's question, not the cursor's: a
  // realtime refetch merges into the live dictionary whether or not
  // localStorage happens to hold a cursor. Asking for them when there is
  // nothing to reconcile pulls every pair the user has ever rejected — a
  // set that only grows, since rejections are retained as the detection
  // engine's denylist — and discards all of it.
  if (includeDeleted) params.append("include-deleted", "true");
  const path = `/api/transfers?${params.toString()}`;
  const response = await call.get<TransfersGetResponse>(path).catch(console.error);
  if (!response || response.status === "error") {
    result.networkFailed = true;
    return result;
  }
  if (!response.body) return result;

  for (const pair of response.body) {
    if (!pair.transactions.length) {
      result.tombstonePairIds.add(pair.pair_id);
      continue;
    }
    result.transfers.set(pair.pair_id, pair);
  }

  return result;
};

interface FetchRecurringsResult {
  recurrings: RecurringDictionary;
  /** Recurring ids the server sent as eviction signals — caller must
   *  `delete` from the context dictionary AND `indexedDb.remove(...)`
   *  per id. */
  tombstoneRecurringIds: Set<string>;
  networkFailed: boolean;
}

/**
 * Delta fetch of recurrings. Same contract as `fetchTransfers`: consumers
 * resolve transaction_id lookups via `recurrings.byTransactionId`, and
 * `useRecurrings` mutates `data.recurrings` in-place via `setData` (no
 * re-fetch on mutation).
 *
 * A recurring leaves the view by being soft-deleted, dismissed, or losing
 * all of its transactions; the server collapses all three into the same
 * wire shape — a recurring with no `transactions` — so the reducer here
 * has one predicate rather than a mirror of the server's visibility rules.
 * Cursor null = full fetch (cold).
 */
const fetchRecurrings = async (
  cursor: string | null,
  includeDeleted: boolean,
): Promise<FetchRecurringsResult> => {
  const result: FetchRecurringsResult = {
    recurrings: new RecurringDictionary(),
    tombstoneRecurringIds: new Set(),
    networkFailed: false,
  };

  const params = new URLSearchParams();
  if (cursor) params.append("start-date", cursor);
  // Same eviction-signal rationale as fetchTransfers: only meaningful when
  // there is a cache to reconcile.
  if (includeDeleted) params.append("include-deleted", "true");
  const path = `/api/recurrings?${params.toString()}`;
  const response = await call.get<RecurringsGetResponse>(path).catch(console.error);
  if (!response || response.status === "error") {
    result.networkFailed = true;
    return result;
  }
  if (!response.body) return result;

  for (const recurring of response.body) {
    if (!recurring.transactions.length) {
      result.tombstoneRecurringIds.add(recurring.recurring_id);
      continue;
    }
    result.recurrings.set(recurring.recurring_id, recurring);
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

  // Dedupe institution_ids across accounts — a single institution can back
  // multiple accounts and the pre-batch fan-out would GET the same id once
  // per account. One batched IN query serves the whole set.
  const ids = Array.from(
    new Set(
      accounts
        .toArray()
        .map((a) => a.institution_id)
        .filter((id) => id && id !== "Unknown"),
    ),
  );
  if (ids.length === 0) return result;

  const response = await call
    .get<InstitutionsGetResponse>(`/api/institutions?ids=${ids.map(encodeURIComponent).join(",")}`)
    .catch(console.error);
  // Any non-success envelope, not just "error": a "failed" one — expired
  // session, or an id list over the route's cap — would otherwise overwrite
  // Data.institutions and the IndexedDB mirror with an empty dictionary.
  if (!response || response.status !== "success") {
    result.networkFailed = true;
    return result;
  }
  if (!response.body) return result;

  for (const institution of response.body) {
    result.institutions.set(institution.institution_id, new Institution(institution));
  }

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

// ---------------------------------------------------------------------------
// Stage helpers (#839). `_sync` is a sequencer over these; each stage is a
// module-scope function so the pure ones can be unit-tested without
// mounting the hook (see sync.test.ts). Stage 5 and the two orchestrators
// stay mount-tested through the #819 render harness.
// ---------------------------------------------------------------------------

/** Everything Stage 1's parallel fan-out returns. */
export interface Stage1Fetched {
  accounts: AccountDictionary;
  items: ItemDictionary;
  holdings: HoldingDictionary;
  budgets: BudgetDictionary;
  sections: SectionDictionary;
  categories: CategoryDictionary;
  charts: ChartDictionary;
  institutions: InstitutionDictionary;
  securities: SecurityDictionary;
  transfers: TransferDictionary;
  tombstonePairIds: Set<string>;
  recurrings: RecurringDictionary;
  tombstoneRecurringIds: Set<string>;
  /** The accounts fetch failed — the orchestrator bails before painting. */
  accountsFailed: boolean;
  /** Any of the other Stage 1 fetches failed — the cursor stays put. */
  fetchFailed: boolean;
}

/** The time-partitioned triple Stage 2 fetches over a recent window and
 *  Stage 3 fetches over the cursor (or unbounded on cold). One shape for
 *  both: Stage 2 is Stage 3 with a 2-months-ago cursor. */
export interface PartitionedFetched {
  transactions: FetchTransactionsResult;
  splits: FetchSplitTransactionsResult;
  snapshots: FetchSnapshotsResult;
}

/** Stage 1 fetch: every non-historical store in parallel. Only
 *  `fetchInstitutions` depends on accounts (chained via the promise).
 *  `includeDeleted` asks the transfers/recurrings routes for eviction
 *  signals — meaningful only when there is a cache to reconcile (warm,
 *  or a cold path whose purge failed). */
export const fetchStage1 = async (
  cursor: string | null,
  includeDeleted: boolean,
): Promise<Stage1Fetched> => {
  const accountsPromise = fetchAccounts();
  const budgetsPromise = fetchBudgets();
  const chartsPromise = fetchCharts();
  const institutionsPromise = accountsPromise.then((r) => fetchInstitutions(r.accounts));
  const securitiesPromise = fetchSecurities();
  const transfersPromise = fetchTransfers(cursor, includeDeleted);
  const recurringsPromise = fetchRecurrings(cursor, includeDeleted);

  const [
    accountsResult,
    budgetsResult,
    chartsResult,
    institutionsResult,
    securitiesResult,
    transfersResult,
    recurringsResult,
  ] = await Promise.all([
    accountsPromise,
    budgetsPromise,
    chartsPromise,
    institutionsPromise,
    securitiesPromise,
    transfersPromise,
    recurringsPromise,
  ]);

  return {
    accounts: accountsResult.accounts,
    items: accountsResult.items,
    holdings: accountsResult.holdings,
    budgets: budgetsResult.budgets,
    sections: budgetsResult.sections,
    categories: budgetsResult.categories,
    charts: chartsResult.charts,
    institutions: institutionsResult.institutions,
    securities: securitiesResult.securities,
    transfers: transfersResult.transfers,
    tombstonePairIds: transfersResult.tombstonePairIds,
    recurrings: recurringsResult.recurrings,
    tombstoneRecurringIds: recurringsResult.tombstoneRecurringIds,
    accountsFailed: accountsResult.networkFailed,
    fetchFailed:
      budgetsResult.networkFailed ||
      chartsResult.networkFailed ||
      institutionsResult.networkFailed ||
      securitiesResult.networkFailed ||
      transfersResult.networkFailed ||
      recurringsResult.networkFailed,
  };
};

/** Warm paint: hand the cached `Data` to React with the loading flags set.
 *  Mutates the cached object's status (it is the cache's own object, not
 *  live state) and returns it for `setData`. */
export const paintCachedWarm = (cached: Data): Data => {
  cached.status.isInit = true;
  cached.status.isLoading = true;
  cached.status.isError = false;
  return cached;
};

/** Cold paint of Stage 1: a fresh `Data` from the fetched non-historical
 *  stores, still loading — the historical fetches haven't run yet. */
export const paintStage1 = (fetched: Stage1Fetched): Data => {
  const stage1 = new Data({
    accounts: fetched.accounts,
    items: fetched.items,
    holdings: fetched.holdings,
    budgets: fetched.budgets,
    sections: fetched.sections,
    categories: fetched.categories,
    charts: fetched.charts,
    institutions: fetched.institutions,
    securities: fetched.securities,
    transfers: fetched.transfers,
    recurrings: fetched.recurrings,
  });
  stage1.status.isInit = true;
  stage1.status.isLoading = true;
  stage1.status.isError = false;
  stage1.status.isColdSync = true;
  return stage1;
};

/** The accounts fetch failed: keep whatever state is showing, clear the
 *  loading flag, and report a real error only on cold — a warm load still
 *  has the cached paint to show. */
export const paintAccountsFailure = (oldData: Data, isWarm: boolean): Data => {
  const next = new Data(oldData);
  next.status.isInit = true;
  next.status.isLoading = false;
  next.status.isError = !isWarm;
  return next;
};

/** Stage 2 fetch: the same partitioned triple as Stage 3, over a recent
 *  window instead of the cursor. */
export const fetchRecentWindow = async (
  accounts: AccountDictionary,
  startDate: string,
): Promise<PartitionedFetched> => {
  const [transactions, splits, snapshots] = await Promise.all([
    fetchTransactions(startDate),
    fetchSplitTransactions(startDate),
    fetchSnapshots(accounts, startDate),
  ]);
  return { transactions, splits, snapshots };
};

/** Stage 3 fetch: the time-partitioned stores via delta (warm) or full
 *  fetch (cold, cursor null). `accounts` feeds the account-snapshot
 *  hydration path in `fetchSnapshots`. */
export const fetchPartitioned = async (
  accounts: AccountDictionary,
  cursor: string | null,
): Promise<PartitionedFetched> => {
  const [transactions, splits, snapshots] = await Promise.all([
    fetchTransactions(cursor),
    fetchSplitTransactions(cursor),
    fetchSnapshots(accounts, cursor),
  ]);
  return { transactions, splits, snapshots };
};

// Per-store delta merges. Each clones the draft's dictionary, sets the
// added/modified rows, and deletes the tombstoned ids — the same merge
// Stage 4 and `_syncDomain` both perform, so a fix to one can't drift
// from the other. They mutate the passed draft (each touches a disjoint
// set of dictionaries, so callers may compose them in any order); the
// callers own the `new Data(oldData)` clone.
const mergeTransactionsDelta = (next: Data, r: FetchTransactionsResult): void => {
  next.transactions = new TransactionDictionary(next.transactions);
  r.transactions.forEach((t, id) => next.transactions.set(id, t));
  r.tombstoneTxIds.forEach((id) => next.transactions.delete(id));
  next.investmentTransactions = new InvestmentTransactionDictionary(next.investmentTransactions);
  r.investmentTransactions.forEach((t, id) => next.investmentTransactions.set(id, t));
  r.tombstoneInvIds.forEach((id) => next.investmentTransactions.delete(id));
};

const mergeSplitTransactionsDelta = (next: Data, r: FetchSplitTransactionsResult): void => {
  next.splitTransactions = new SplitTransactionDictionary(next.splitTransactions);
  r.splitTransactions.forEach((t, id) => next.splitTransactions.set(id, t));
  r.tombstoneSplitIds.forEach((id) => next.splitTransactions.delete(id));
};

const mergeSnapshotsDelta = (next: Data, r: FetchSnapshotsResult): void => {
  next.accountSnapshots = new AccountSnapshotDictionary(next.accountSnapshots);
  r.accountSnapshots.forEach((s, id) => next.accountSnapshots.set(id, s));
  r.tombstoneAccountSnapshotIds.forEach((id) => next.accountSnapshots.delete(id));
  next.holdingSnapshots = new HoldingSnapshotDictionary(next.holdingSnapshots);
  r.holdingSnapshots.forEach((s, id) => next.holdingSnapshots.set(id, s));
  r.tombstoneHoldingSnapshotIds.forEach((id) => next.holdingSnapshots.delete(id));
  next.securitySnapshots = new SecuritySnapshotDictionary(next.securitySnapshots);
  r.securitySnapshots.forEach((s, id) => next.securitySnapshots.set(id, s));
  r.tombstoneSecuritySnapshotIds.forEach((id) => next.securitySnapshots.delete(id));
};

const mergeTransfersDelta = (
  next: Data,
  r: Pick<FetchTransfersResult, "transfers" | "tombstonePairIds">,
): void => {
  next.transfers = new TransferDictionary(next.transfers);
  r.transfers.forEach((p, id) => next.transfers.set(id, p));
  r.tombstonePairIds.forEach((id) => next.transfers.delete(id));
};

const mergeRecurringsDelta = (
  next: Data,
  r: Pick<FetchRecurringsResult, "recurrings" | "tombstoneRecurringIds">,
): void => {
  next.recurrings = new RecurringDictionary(next.recurrings);
  r.recurrings.forEach((rec, id) => next.recurrings.set(id, rec));
  r.tombstoneRecurringIds.forEach((id) => next.recurrings.delete(id));
};

/** Stage 2 paint: merge the recent window over the Stage 1 paint. The
 *  unbounded Stage 3 fetch hasn't run yet, so months older than the
 *  window have no transactions in memory — rollover accrual clamps to
 *  the loaded window while `isColdSync` is set. */
export const paintRecentWindow = (oldData: Data, recent: PartitionedFetched): Data => {
  const next = new Data(oldData);
  mergeTransactionsDelta(next, recent.transactions);
  mergeSplitTransactionsDelta(next, recent.splits);
  mergeSnapshotsDelta(next, recent.snapshots);
  next.status.isInit = true;
  next.status.isLoading = true;
  next.status.isError = false;
  next.status.isColdSync = true;
  return next;
};

/** Stage 4 apply: the Stage 1 stores replace wholesale; the partitioned
 *  stores (and transfers/recurrings) merge as deltas over the previous
 *  state. Identical on warm and cold — on cold the delta IS the whole
 *  set, so the merge over Stage 1's paint is a no-op overlay. Either way
 *  the unbounded fetch commits the full history, so the cold-streaming
 *  window is over (`isColdSync` clears). */
export const applyDelta = (
  oldData: Data,
  stage1: Stage1Fetched,
  partitioned: PartitionedFetched,
): Data => {
  const next = new Data(oldData);
  next.accounts = stage1.accounts;
  next.holdings = stage1.holdings;
  next.items = stage1.items;
  next.budgets = stage1.budgets;
  next.sections = stage1.sections;
  next.categories = stage1.categories;
  next.charts = stage1.charts;
  next.institutions = stage1.institutions;
  next.securities = stage1.securities;
  mergeTransfersDelta(next, stage1);
  mergeRecurringsDelta(next, stage1);
  mergeTransactionsDelta(next, partitioned.transactions);
  mergeSplitTransactionsDelta(next, partitioned.splits);
  mergeSnapshotsDelta(next, partitioned.snapshots);
  next.status.isInit = true;
  next.status.isLoading = false;
  next.status.isError = false;
  next.status.isColdSync = false;
  return next;
};

// Per-store persist: the `saveMany` writes for added/modified rows plus
// per-row `remove` for tombstones — the same persist Stage 5 and
// `_syncDomain` both perform. Returned as promise arrays so the caller
// decides `all` vs `allSettled`.
const persistTransactionsDelta = (r: FetchTransactionsResult): Promise<void>[] => [
  indexedDb.saveTransactions(r.transactions),
  indexedDb.saveInvestmentTransactions(r.investmentTransactions),
  ...[...r.tombstoneTxIds].map((id) => indexedDb.remove(StoreName.transactions, id)),
  ...[...r.tombstoneInvIds].map((id) => indexedDb.remove(StoreName.investmentTransactions, id)),
];

const persistSplitTransactionsDelta = (r: FetchSplitTransactionsResult): Promise<void>[] => [
  indexedDb.saveSplitTransactions(r.splitTransactions),
  ...[...r.tombstoneSplitIds].map((id) => indexedDb.remove(StoreName.splitTransactions, id)),
];

const persistSnapshotsDelta = (r: FetchSnapshotsResult): Promise<void>[] => [
  indexedDb.saveAccountSnapshots(r.accountSnapshots),
  indexedDb.saveHoldingSnapshots(r.holdingSnapshots),
  indexedDb.saveSecuritySnapshots(r.securitySnapshots),
  ...[...r.tombstoneAccountSnapshotIds].map((id) =>
    indexedDb.remove(StoreName.accountSnapshots, id),
  ),
  ...[...r.tombstoneHoldingSnapshotIds].map((id) =>
    indexedDb.remove(StoreName.holdingSnapshots, id),
  ),
  ...[...r.tombstoneSecuritySnapshotIds].map((id) =>
    indexedDb.remove(StoreName.securitySnapshots, id),
  ),
];

const persistTransfersDelta = (
  r: Pick<FetchTransfersResult, "transfers" | "tombstonePairIds">,
): Promise<void>[] => [
  indexedDb.saveTransfers(r.transfers),
  ...[...r.tombstonePairIds].map((id) => indexedDb.remove(StoreName.transfers, id)),
];

const persistRecurringsDelta = (
  r: Pick<FetchRecurringsResult, "recurrings" | "tombstoneRecurringIds">,
): Promise<void>[] => [
  indexedDb.saveRecurrings(r.recurrings),
  ...[...r.tombstoneRecurringIds].map((id) => indexedDb.remove(StoreName.recurrings, id)),
];

/** What Stage 5 decided: the cursor outcome, and whether anything
 *  failed along the way. */
export interface PersistOutcome {
  cursorUpdate: "advance" | "clear" | "keep";
  fetchFailed: boolean;
  idbFailed: boolean;
}

/** Stage 5: persist the fetched delta to IDB, then advance (or clear)
 *  the cursor. AWAITED by the orchestrator so the cursor write happens
 *  AFTER IDB is durable — a page reload right after sync sees the same
 *  state the cursor advertises. The cursor advances ONLY if every fetch
 *  AND every IDB write succeeded: advancing on a swallowed IDB save error
 *  would permanently lose the row (React state has it, IDB doesn't;
 *  once the 60s cursor margin elapses the server stops re-emitting). */
export const persistAndAdvance = async (args: {
  stage1: Stage1Fetched;
  partitioned: PartitionedFetched;
  syncStartedAt: Date;
  purgeFailed: boolean;
  skippedWritesAtStart: number;
}): Promise<PersistOutcome> => {
  const { stage1, partitioned, syncStartedAt, purgeFailed, skippedWritesAtStart } = args;
  const fetchFailed =
    stage1.fetchFailed ||
    partitioned.transactions.networkFailed ||
    partitioned.splits.networkFailed ||
    partitioned.snapshots.networkFailed;

  // Non-time-partitioned stores: explicit per-store saves (avoids
  // `saveAllData`'s 6 empty-dict transactions). Time-partitioned
  // stores save the delta dict — the previous-sync state for any
  // row that wasn't in this delta is already on disk from the
  // sync that fetched it (idempotent per-id put).
  const idbSaves: Promise<void>[] = [
    indexedDb.saveAccounts(stage1.accounts),
    indexedDb.saveHoldings(stage1.holdings),
    indexedDb.saveItems(stage1.items),
    indexedDb.saveBudgets(stage1.budgets),
    indexedDb.saveSections(stage1.sections),
    indexedDb.saveCategories(stage1.categories),
    indexedDb.saveCharts(stage1.charts),
    indexedDb.saveInstitutions(stage1.institutions),
    indexedDb.saveSecurities(stage1.securities),
    ...persistTransfersDelta(stage1),
    ...persistRecurringsDelta(stage1),
    ...persistTransactionsDelta(partitioned.transactions),
    ...persistSplitTransactionsDelta(partitioned.splits),
    ...persistSnapshotsDelta(partitioned.snapshots),
  ];

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

  const cursorUpdate = cursorUpdateAfterSync({
    purgeFailed,
    fetchFailed,
    idbFailed,
    writesSkipped: indexedDbAccessor.skippedWrites !== skippedWritesAtStart,
  });
  if (cursorUpdate === "advance") writeLastSyncedCursor(cursorForNextSync(syncStartedAt));
  else if (cursorUpdate === "clear") removeLastSyncedCursor();
  return { cursorUpdate, fetchFailed, idbFailed };
};

// Module-scoped so the timeout survives the originating component's
// unmount — `_sync` must fire regardless of whether the caller is
// still mounted (clean() → setData(new Data()) flips status.isInit and
// unmounts the page during refresh).
let syncDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
const debounceSync = (callback: () => void, delay = 50) => {
  if (syncDebounceTimeout) clearTimeout(syncDebounceTimeout);
  syncDebounceTimeout = setTimeout(callback, delay);
};

// Per-domain debounce for `syncDomain`. A burst of `<domain>-updated`
// events for the same domain collapses into a single refetch; different
// domains debounce independently so a `transactions-updated` doesn't
// swallow a concurrent `budgets-updated`.
const domainDebounceTimeouts = new Map<TableName, ReturnType<typeof setTimeout>>();
const debounceDomain = (
  domain: TableName,
  callback: () => void,
  delay = 50,
) => {
  const existing = domainDebounceTimeouts.get(domain);
  if (existing) clearTimeout(existing);
  domainDebounceTimeouts.set(
    domain,
    setTimeout(() => {
      domainDebounceTimeouts.delete(domain);
      callback();
    }, delay),
  );
};

export const useSync = () => {
  const { user, setData } = useAppContext();
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
      const skippedWritesAtStart = indexedDbAccessor.skippedWrites;

      const cached = await indexedDb.loadAllData().catch((err) => {
        console.error(err);
        return null;
      });
      const cursorRaw = readLastSyncedCursor();
      // Warm requires a populated IDB cache (accounts AND at least one
      // time-partitioned store) AND a previously-recorded cursor. Any missing
      // → cold (full fetch, no cursor on the wire) so the time-partitioned
      // history can re-hydrate from scratch.
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
      // A purge that rejects leaves the pre-existing rows in place, so the
      // cold response alone can no longer be trusted to be the whole truth
      // — ask for eviction signals after all, the way the four sibling
      // stores get them unconditionally from their routes. Only the healthy
      // cold path skips them.
      let purgeFailed = false;
      if (!isWarm) {
        await indexedDb.clearAllData().catch((err) => {
          console.error(err);
          purgeFailed = true;
        });
      }
      // Pass the cursor to delta fetches ONLY on the warm branch. The
      // cold path must fetch the full history with no `start-date=` —
      // if localStorage has a stale cursor (IDB cleared by quota / DevTools,
      // or `clean()`'s clearAllData racing the next sync), sending the cursor
      // would return only rows updated since it and the reducer's empty-base
      // would commit a near-empty dataset to React state.
      const cursor = isWarm ? cursorRaw : null;

      // ===== Stage 1: non-historical data (cheap, paints fast). =====
      // Accounts/items, budgets/sections/categories, charts,
      // institutions, securities, transfers. None of these are
      // time-partitioned. Refreshed on every sync (warm + cold).
      //
      // For warm load, we paint cached state first so the UI doesn't
      // flicker between cache and the refreshed view of Stage 1. A resync of
      // a page already showing data skips it: the live state is at least as
      // new as the cache, and swapping the cache in rebuilds every row.
      if (isWarm && cached && !globalData.status.isInit) {
        setData(paintCachedWarm(cached));
      }

      const stage1 = await fetchStage1(cursor, isWarm || purgeFailed);

      if (stage1.accountsFailed) {
        // Setdata via the updater so React sees a distinct reference
        // and commits; the warm-path paint above already committed the
        // same `cached` ref, so `setData(cached)` would Object.is-bail
        // and strand the loading flag.
        setData((oldData) => paintAccountsFailure(oldData, isWarm));
        return;
      }

      // On a cold load, paint Stage 1 immediately so the navigation +
      // summary widgets render before the historical fetches finish.
      // On warm load, the cached paint above already covered this; the
      // delta apply below replaces what changed.
      if (!isWarm) {
        setData(paintStage1(stage1));
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
        const recent = await fetchRecentWindow(stage1.accounts, twoMonthsAgo);
        setData((oldData) => paintRecentWindow(oldData, recent));
      }

      // ===== Stage 3: time-partitioned stores via delta/full fetch. =====
      // Cursor null on cold → unbounded GET (fills in older months
      // after Stage 2 painted recent ones). Cursor set on warm →
      // server returns only rows whose `updated >= cursor`. The route
      // filter is inclusive; cursor includes a safety margin so
      // borderline rows aren't missed at the cost of a small per-sync
      // re-fetch of the last minute's changes.
      const partitioned = await fetchPartitioned(stage1.accounts, cursor);

      // ===== Stage 4: apply (warm + cold: in-place merge on `oldData`). =====
      // Existing state stays — added/modified rows overwrite their ids in the
      // cloned dictionary; tombstoned ids are explicitly deleted. The calc
      // depends on prior state, so the orchestrator can't just
      // `new Data(refreshed)`. On cold load, Stage 2's recent-window paint is
      // already in oldData; Stage 4's unbounded fetch overlays the same rows
      // (idempotent) and fills in the older months.
      setData((oldData) => applyDelta(oldData, stage1, partitioned));

      // ===== Stage 5: persist + advance the cursor. =====
      // Per-store batched `saveMany` writes for added/modified entries and
      // per-row `remove` for tombstones. AWAITED so the cursor write happens
      // AFTER IDB is durable — a page reload right after sync sees the same
      // state the cursor advertises. Cursor advances ONLY if every fetch AND
      // every IDB write succeeded: advancing on a swallowed IDB save error
      // would permanently lose the row (React state has it, IDB doesn't;
      // once the 60s cursor margin elapses the server stops re-emitting).
      await persistAndAdvance({
        stage1,
        partitioned,
        syncStartedAt,
        purgeFailed,
        skippedWritesAtStart,
      });
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

  const sync = useCallback(() => debounceSync(_sync), [_sync]);

  // Refetch a single table's slot and merge it into `Data`. Called by the
  // real-time receiver on `<table>-updated` events so a mutation in one
  // domain doesn't burn a whole-app refresh. Uses the cursor when present
  // (delta for time-partitioned tables) but does NOT advance it — only the
  // full `sync()` owns cursor advancement, because it fetches every domain.
  const _syncDomain = useCallback(
    async (domain: TableName) => {
      if (!user) return;
      const cursor = readLastSyncedCursor();
      try {
        switch (domain) {
          case TableName.Transactions:
          case TableName.InvestmentTransactions: {
            const r = await fetchTransactions(cursor);
            if (r.networkFailed) return;
            setData((oldData) => {
              const next = new Data(oldData);
              mergeTransactionsDelta(next, r);
              return next;
            });
            await Promise.allSettled(persistTransactionsDelta(r));
            return;
          }
          case TableName.SplitTransactions: {
            const r = await fetchSplitTransactions(cursor);
            if (r.networkFailed) return;
            setData((oldData) => {
              const next = new Data(oldData);
              mergeSplitTransactionsDelta(next, r);
              return next;
            });
            await Promise.allSettled(persistSplitTransactionsDelta(r));
            return;
          }
          case TableName.Snapshots: {
            // fetchSnapshots needs the accounts dict for the account-snapshot
            // hydration path. Read from the mutable `globalData` mirror (kept
            // in lockstep with React state by `useData`'s setData wrapper) —
            // reading via a setData updater has an eager-bailout hazard when
            // any sibling AppContext state has a pending update, dropping the
            // refetch silently.
            const r = await fetchSnapshots(globalData.accounts, cursor);
            if (r.networkFailed) return;
            setData((oldData) => {
              const next = new Data(oldData);
              mergeSnapshotsDelta(next, r);
              return next;
            });
            await Promise.allSettled(persistSnapshotsDelta(r));
            return;
          }
          case TableName.Accounts:
          case TableName.Items:
          case TableName.Holdings: {
            const r = await fetchAccounts();
            if (r.networkFailed) return;
            const inst = await fetchInstitutions(r.accounts);
            setData((oldData) => {
              const next = new Data(oldData);
              next.accounts = r.accounts;
              next.items = r.items;
              next.holdings = r.holdings;
              if (!inst.networkFailed) next.institutions = inst.institutions;
              return next;
            });
            await Promise.allSettled([
              indexedDb.saveAccounts(r.accounts),
              indexedDb.saveItems(r.items),
              indexedDb.saveHoldings(r.holdings),
              !inst.networkFailed
                ? indexedDb.saveInstitutions(inst.institutions)
                : Promise.resolve(),
            ]);
            return;
          }
          case TableName.Budgets:
          case TableName.Sections:
          case TableName.Categories: {
            const r = await fetchBudgets();
            if (r.networkFailed) return;
            setData((oldData) => {
              const next = new Data(oldData);
              next.budgets = r.budgets;
              next.sections = r.sections;
              next.categories = r.categories;
              return next;
            });
            await Promise.allSettled([
              indexedDb.saveBudgets(r.budgets),
              indexedDb.saveSections(r.sections),
              indexedDb.saveCategories(r.categories),
            ]);
            return;
          }
          case TableName.Charts: {
            const r = await fetchCharts();
            if (r.networkFailed) return;
            setData((oldData) => {
              const next = new Data(oldData);
              next.charts = r.charts;
              return next;
            });
            await indexedDb.saveCharts(r.charts).catch(console.error);
            return;
          }
          case TableName.TransactionPairs: {
            // Always merges into the live dictionary, so it always needs
            // eviction signals — a rejected pair has to leave the screen
            // even for a user whose cursor is missing (blocked
            // localStorage, backwards clock jump).
            const r = await fetchTransfers(cursor, true);
            if (r.networkFailed) return;
            setData((oldData) => {
              const next = new Data(oldData);
              mergeTransfersDelta(next, r);
              return next;
            });
            await Promise.allSettled(persistTransfersDelta(r));
            return;
          }
          case TableName.Recurrings: {
            // Same merge-with-evictions contract as TransactionPairs: a
            // dismissed recurring has to leave the screen even for a user
            // whose cursor is missing.
            const r = await fetchRecurrings(cursor, true);
            if (r.networkFailed) return;
            setData((oldData) => {
              const next = new Data(oldData);
              mergeRecurringsDelta(next, r);
              return next;
            });
            await Promise.allSettled(persistRecurringsDelta(r));
            return;
          }
          case TableName.Securities: {
            const r = await fetchSecurities();
            if (r.networkFailed) return;
            setData((oldData) => {
              const next = new Data(oldData);
              next.securities = r.securities;
              return next;
            });
            await indexedDb.saveSecurities(r.securities).catch(console.error);
            return;
          }
          case TableName.Institutions: {
            const r = await fetchInstitutions(globalData.accounts);
            if (r.networkFailed) return;
            setData((oldData) => {
              const next = new Data(oldData);
              next.institutions = r.institutions;
              return next;
            });
            await indexedDb.saveInstitutions(r.institutions).catch(console.error);
            return;
          }
          // Tables the client doesn't mirror into `Data` — no-op.
          case TableName.Users:
          case TableName.Sessions:
          case TableName.ApiKeys:
          case TableName.RejectedCategories:
            return;
          default: {
            // Exhaustiveness guard: adding a new `TableName` value that
            // syncDomain doesn't handle is a compile-time error here.
            const unhandled: never = domain;
            console.warn(`syncDomain: unhandled domain "${unhandled}" — no-op`);
            return;
          }
        }
      } catch (err) {
        console.error(err);
      }
    },
    [setData, user],
  );
  const syncDomain = useCallback(
    (domain: TableName) => debounceDomain(domain, () => _syncDomain(domain)),
    [_syncDomain],
  );

  const clean = useCallback(async () => {
    // Await `clearAllData` so the next sync's `loadAllData` sees an empty
    // IDB when the purge succeeds. It is an attempt, not a guarantee —
    // `onClickRefresh` awaits this, but a rejecting IDB still resolves. What
    // makes that safe is the cursor: clearing it sends the next sync down
    // the cold path, which re-purges and tracks `purgeFailed`.
    //
    // Neither caller awaits or catches this, so a rejection must not take
    // the two steps below it down with it.
    await indexedDb.clearAllData().catch(console.error);
    removeLastSyncedCursor();
    setData(new Data());
  }, [setData]);

  return { sync, syncDomain, clean };
};
