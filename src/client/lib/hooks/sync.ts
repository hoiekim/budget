import { useCallback } from "react";
import {
  ViewDate,
  getDateString,
  THIRTY_DAYS,
  JSONInstitution,
  JSONSnapshotData,
  LocalDate,
  Queue,
} from "common";
import {
  BudgetsGetResponse,
  TransactionsGetResponse,
  OldestTransactionDateGetResponse,
  ApiResponse,
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
  cachedCall,
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

// Browsers cap concurrent fetches per origin (~6 on HTTP/1.1) and queueing
// hundreds of `fetch`/`cache.add` calls at once triggers
// ERR_INSUFFICIENT_RESOURCES — which silently aborts `cache.add` and defeats
// the Cache API benefit for older months. Gate snapshot fetches through a
// shared Queue so at most 6 are in flight at any time.
const snapshotFetchQueue = new Queue({ maxInflight: 6 });

// Presence of the key gates warm-vs-cold: a known previous sync means
// the IndexedDB cache is trustworthy enough to paint upfront. The value
// drives the warm path's freshness window (`recentSinceMs =
// lastSyncedAt − FRESHNESS_WINDOW_MS`), passed to
// fetchTransactions/fetchSnapshots so months in that window go to
// network and older months use the browser Cache API. Absent → cold
// (avoids the failure mode where IndexedDB has stale data without a
// known cutoff).
const LAST_SYNCED_AT_KEY = "budget:lastSyncedAt";
// How far back from `lastSyncedAt` we consider "potentially stale" on
// the client. Wider than Plaid's pending→posted restatement window
// (commonly cited as ~14d) to also catch user labels / category
// edits that happened on another device since the last sync.
const FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const readLastSyncedAt = (): Date | null => {
  try {
    const raw = window.localStorage.getItem(LAST_SYNCED_AT_KEY);
    if (!raw) return null;
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) return null;
    // Reject future timestamps (clock skew between sessions / device wake) —
    // treat them as missing so we err on the side of a wider refresh.
    if (t > Date.now()) return null;
    return new Date(t);
  } catch {
    return null;
  }
};

const writeLastSyncedAt = (date: Date) => {
  try {
    window.localStorage.setItem(LAST_SYNCED_AT_KEY, date.toISOString());
  } catch {
    // localStorage can throw in private-mode iOS / over quota. Best
    // effort; next warm load will fall back to cold path, which is
    // correct but slower.
  }
};

const removeLastSyncedAt = () => {
  try {
    window.localStorage.removeItem(LAST_SYNCED_AT_KEY);
  } catch {
    // no-op
  }
};

const getOldestTransactionDate = async (): Promise<Date | undefined> => {
  const response = await call
    .get<OldestTransactionDateGetResponse>("/api/oldest-transaction-date")
    .catch(console.error);
  if (!response?.body) return undefined;
  return response.body ? new LocalDate(response.body) : undefined;
};

interface FetchTransactionsResult {
  transactions: TransactionDictionary;
  investmentTransactions: InvestmentTransactionDictionary;
  networkFailed: boolean;
}

interface FetchRange {
  /** Inclusive lower bound on the month start date — loop stops when viewDate < this. */
  from: Date;
  /** Exclusive upper bound on the month start date — loop starts at this month-1. */
  until: Date;
}

const fetchTransactions = async (
  accounts: AccountDictionary,
  range: FetchRange,
  // Months whose end falls at or after `recentSinceMs` bypass the browser
  // Cache API (call) and go to network; older months use cachedCall.
  // Default mirrors the original "last 30 days from now" semantic so the
  // cold path keeps current behavior. The warm path overrides it with
  // `lastSyncedAt − 30d` so the freshness threshold tracks the user's
  // own gap between visits, not wall clock.
  recentSinceMs: number = Date.now() - THIRTY_DAYS,
): Promise<FetchTransactionsResult> => {
  const result: FetchTransactionsResult = {
    transactions: new TransactionDictionary(),
    investmentTransactions: new InvestmentTransactionDictionary(),
    networkFailed: false,
  };

  // Tombstones collected from any month's response. Applied at the end
  // so eviction wins regardless of which parallel response arrived
  // last — mirrors the snapshot-side handling and avoids a stale
  // `cachedCall` response re-adding a row the live query already
  // marked deleted.
  const tombstones = {
    transaction: new Set<string>(),
    investmentTransaction: new Set<string>(),
  };

  const transactionsApiPath = "/api/transactions";
  const viewDate = new ViewDate("month");
  // Walk back to the first month whose start < range.until.
  while (viewDate.getStartDate() >= range.until) viewDate.previous();

  const promises: Promise<void>[] = [];

  while (range.from < viewDate.getStartDate()) {
    accounts?.forEach((a) => {
      const params = new URLSearchParams();
      const startDate = viewDate.getStartDate();
      const endDate = viewDate.clone().next().getStartDate();
      params.append("start-date", getDateString(startDate));
      params.append("end-date", getDateString(endDate));
      params.append("account-id", a.id);
      // Route hardcodes `includeDeleted: true` (matches snapshots) — the
      // soft-deleted rows arrive as tombstones in the response and are
      // dropped from `result.transactions` / IDB below.
      const path = transactionsApiPath + "?" + params.toString();
      const isRecent = endDate.getTime() >= recentSinceMs;

      const fetchTransactionsForAccount = async () => {
        let response: ApiResponse<TransactionsGetResponse> | void;
        if (isRecent) {
          response = await call.get<TransactionsGetResponse>(path).catch(console.error);
        } else {
          response = await cachedCall<TransactionsGetResponse>(path).catch(console.error);
        }
        if (!response || response.status === "error") {
          result.networkFailed = true;
          return;
        }
        if (!response.body) return;

        const { transactions, investmentTransactions } = response.body;
        transactions.forEach((t) => {
          if (t.is_deleted) {
            tombstones.transaction.add(t.transaction_id);
            return;
          }
          result.transactions.set(t.transaction_id, new Transaction(t));
        });
        investmentTransactions.forEach((t) => {
          if (t.is_deleted) {
            tombstones.investmentTransaction.add(t.investment_transaction_id);
            return;
          }
          result.investmentTransactions.set(
            t.investment_transaction_id,
            new InvestmentTransaction(t),
          );
        });
      };
      const promise = fetchTransactionsForAccount();

      promises.push(promise);
    });

    viewDate.previous();
  }

  await Promise.all(promises);

  // Apply tombstones after every parallel ingest has landed — same
  // semantics as the snapshot path. The eager `indexedDb.remove` is
  // load-bearing for the partial-failure branch in `useSync` (line
  // ~671): when any fetch fails, `clearAllData → saveAllData` is
  // skipped, so the only thing that drops the tombstoned row from IDB
  // is this explicit remove. (The happy-path branches still
  // clear-then-save from `result`, which would also drop it.)
  tombstones.transaction.forEach((id) => {
    result.transactions.delete(id);
    indexedDb.remove(StoreName.transactions, id).catch(console.error);
  });
  tombstones.investmentTransaction.forEach((id) => {
    result.investmentTransactions.delete(id);
    indexedDb.remove(StoreName.investmentTransactions, id).catch(console.error);
  });

  return result;
};

interface FetchSplitTransactionsResult {
  splitTransactions: SplitTransactionDictionary;
  networkFailed: boolean;
}

const fetchSplitTransactions = async (): Promise<FetchSplitTransactionsResult> => {
  // Single unbounded GET — splits are small (well under any pagination
  // threshold for current users) and the per-month-per-account paged
  // shape from the initial draft of this PR introduced an FE coverage
  // regression under high concurrency (1100+ in-flight fetches dropped
  // rows across the response stream — see PR #522 thread). The
  // `is_deleted` flag still rides on every row so the FE can branch into
  // active vs tombstone here, matching the snapshot path's eviction
  // semantics. The server still supports the paged shape (route + repo
  // accept startDate/endDate/account-id) so a future delta-cursor design
  // can adopt pagination uniformly across all three stores at once.
  const result: FetchSplitTransactionsResult = {
    splitTransactions: new SplitTransactionDictionary(),
    networkFailed: false,
  };

  const tombstones = new Set<string>();

  const response = await call
    .get<SplitTransactionsGetResponse>("/api/split-transactions")
    .catch(console.error);
  if (!response || response.status === "error") {
    result.networkFailed = true;
    return result;
  }

  response.body?.forEach((t) => {
    if (t.is_deleted) {
      tombstones.add(t.split_transaction_id);
      return;
    }
    result.splitTransactions.set(t.split_transaction_id, new SplitTransaction(t));
  });

  tombstones.forEach((id) => {
    indexedDb.remove(StoreName.splitTransactions, id).catch(console.error);
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

  console.log("[debug fetchTransfers] populated transfers, size=", result.transfers.size);
  return result;
};

interface FetchSnapshotsResult {
  accountSnapshots: AccountSnapshotDictionary;
  holdingSnapshots: HoldingSnapshotDictionary;
  securitySnapshots: SecuritySnapshotDictionary;
  networkFailed: boolean;
}

const fetchSnapshots = async (
  accounts: AccountDictionary,
  range: FetchRange,
  // Same semantic as `fetchTransactions`: months whose end is at or after
  // `recentSinceMs` go to network; older months use cachedCall.
  recentSinceMs: number = Date.now() - THIRTY_DAYS,
): Promise<FetchSnapshotsResult> => {
  const result: FetchSnapshotsResult = {
    accountSnapshots: new AccountSnapshotDictionary(),
    holdingSnapshots: new HoldingSnapshotDictionary(),
    securitySnapshots: new SecuritySnapshotDictionary(),
    networkFailed: false,
  };

  // Tombstones collected from any month's response. Applied at the end
  // so the eviction wins regardless of which parallel response arrived
  // last — without this, a tombstone from June's live query loses to a
  // cached older-month response that still has the row as active.
  const tombstones = {
    account: new Set<string>(),
    holding: new Set<string>(),
    security: new Set<string>(),
  };

  const ingestSnapshot = (snapshot: JSONSnapshotData) => {
    if (snapshot.snapshot.is_deleted) {
      const id = snapshot.snapshot.snapshot_id;
      if ("account" in snapshot) tombstones.account.add(id);
      else if ("holding" in snapshot) tombstones.holding.add(id);
      else if ("security" in snapshot) tombstones.security.add(id);
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
  };

  // Mirror fetchTransactions (Closes #323): slice the full date window into
  // month-sized chunks, fetched per-account for user-scoped snapshots and
  // once-per-month for shared security snapshots. Months whose end falls
  // at or after `recentSinceMs` bypass the browser Cache API and go to
  // network; older months use cachedCall.
  const snapshotsApiPath = "/api/snapshots";
  const viewDate = new ViewDate("month");
  while (viewDate.getStartDate() >= range.until) viewDate.previous();

  const promises: Promise<void>[] = [];

  while (range.from < viewDate.getStartDate()) {
    const monthStart = viewDate.getStartDate();
    const monthEnd = viewDate.clone().next().getStartDate();
    const startStr = getDateString(monthStart);
    const endStr = getDateString(monthEnd);
    const isRecent = monthEnd.getTime() >= recentSinceMs;

    accounts?.forEach((a) => {
      const params = new URLSearchParams();
      params.append("start-date", startStr);
      params.append("end-date", endStr);
      params.append("account-id", a.id);
      const path = snapshotsApiPath + "?" + params.toString();

      promises.push(
        snapshotFetchQueue.add(async () => {
          let response: ApiResponse<SnapshotsGetResponse> | void;
          if (isRecent) {
            response = await call.get<SnapshotsGetResponse>(path).catch(console.error);
          } else {
            response = await cachedCall<SnapshotsGetResponse>(path).catch(console.error);
          }
          if (!response || response.status === "error") {
            result.networkFailed = true;
            return;
          }
          response.body?.forEach(ingestSnapshot);
        }),
      );
    });

    // Security snapshots are user-id=NULL (shared) and aren't returned by
    // the account-scoped queries above. One slice per month, cached for
    // older months — keeps the per-account URL space cleanly cache-keyed
    // and avoids re-pulling the full price history on every page load.
    const securityParams = new URLSearchParams();
    securityParams.append("start-date", startStr);
    securityParams.append("end-date", endStr);
    securityParams.append("snapshot-type", "security");
    const securityPath = snapshotsApiPath + "?" + securityParams.toString();

    promises.push(
      snapshotFetchQueue.add(async () => {
        let response: ApiResponse<SnapshotsGetResponse> | void;
        if (isRecent) {
          response = await call.get<SnapshotsGetResponse>(securityPath).catch(console.error);
        } else {
          response = await cachedCall<SnapshotsGetResponse>(securityPath).catch(console.error);
        }
        if (!response || response.status === "error") {
          result.networkFailed = true;
          return;
        }
        response.body?.forEach(ingestSnapshot);
      }),
    );

    viewDate.previous();
  }

  await Promise.all(promises);

  // Apply tombstones after every parallel ingest has landed: drop the
  // id from the dict (in case a stale cachedCall response re-added it)
  // AND evict from IDB. Order matters — the dict-delete must happen
  // before the consumer hands the dict to `saveAllData`, which would
  // otherwise persist the stale row right back.
  tombstones.account.forEach((id) => {
    result.accountSnapshots.delete(id);
    indexedDb.remove(StoreName.accountSnapshots, id).catch(console.error);
  });
  tombstones.holding.forEach((id) => {
    result.holdingSnapshots.delete(id);
    indexedDb.remove(StoreName.holdingSnapshots, id).catch(console.error);
  });
  tombstones.security.forEach((id) => {
    result.securitySnapshots.delete(id);
    indexedDb.remove(StoreName.securitySnapshots, id).catch(console.error);
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
    const response = await cachedCall<JSONInstitution>(
      `/api/institution?id=${institution_id}`,
    ).catch(console.error);
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
      // Read IndexedDB synchronously up front. On a warm load (any cached
      // accounts) we paint from cache immediately and only refresh the
      // current month — full Stage 1/2/3 slicing is reserved for cold
      // load (no IndexedDB). The previous fire-and-forget then-callback
      // raced with Stage 1's setData(new Data({...})) which carries no
      // transactions/snapshots, blowing away the cached history one
      // frame after it painted (#399).
      const cached = await indexedDb.loadAllData().catch((err) => {
        console.error(err);
        return null;
      });
      const lastSyncedAt = readLastSyncedAt();
      // Warm-load preconditions: cached data with at least one account,
      // AND a previously persisted sync timestamp. The timestamp drives
      // the warm path's freshness window (`recentSinceMs =
      // lastSyncedAt − 30d`) which decides per-month whether to go to
      // network or use the browser Cache API. Absent timestamp →
      // cache is opaque, fall through to cold.
      const isWarm = !!cached && cached.accounts.size > 0 && lastSyncedAt !== null;

      if (isWarm && cached && lastSyncedAt) {
        const accountsPromise = fetchAccounts();
        const { networkFailed } = await accountsPromise;

        if (networkFailed) {
          // Offline / server down — use cache as-is, no refresh.
          cached.status.isInit = true;
          cached.status.isLoading = false;
          cached.status.isError = false;
          setData(cached);
          return;
        }

        // Paint from cache immediately; flag still-loading so the UI
        // can show a refresh indicator while the full fetch settles.
        cached.status.isInit = true;
        cached.status.isLoading = true;
        cached.status.isError = false;
        setData(cached);

        const { accounts, items, holdings } = await accountsPromise;

        // Full-history fetch (`[oldestDate or 3-months-ago, currentMonth + 1)`)
        // — same range the cold path covers via Stage 2 + Stage 3. The
        // narrow freshness window from the prior warm-path design
        // (`[lastSyncedAt − 30d, now]`) is now passed as `recentSinceMs`
        // to drive the per-month `isRecent` decision inside
        // fetchTransactions / fetchSnapshots: months whose end falls
        // in that freshness window go to network (call), older months
        // use cachedCall and come from the browser Cache API. Net effect:
        // state always reflects the full server view, only the recent
        // months pay network cost, the rest are essentially free.
        const currentViewDate = new ViewDate("month");
        const oldestDatePromise = getOldestTransactionDate();
        const oldestDate = await oldestDatePromise;
        const defaultFrom = currentViewDate.clone().previous().previous().previous().getStartDate();
        const fullFrom = oldestDate && oldestDate < defaultFrom ? oldestDate : defaultFrom;
        const fullUntil = currentViewDate.clone().next().getStartDate();
        const fullRange: FetchRange = { from: fullFrom, until: fullUntil };
        // Freshness window: 30 days back from the last sync. Anything
        // newer than this is potentially-stale on the client and needs a
        // re-fetch; anything older we trust the HTTP cache for.
        const recentSinceMs = lastSyncedAt.getTime() - FRESHNESS_WINDOW_MS;

        const [
          budgetsResult,
          chartsResult,
          splitTransactionsResult,
          transactionsResult,
          snapshotsResult,
          institutionsResult,
          securitiesResult,
          transfersResult,
        ] = await Promise.all([
          fetchBudgets(),
          fetchCharts(),
          fetchSplitTransactions(),
          fetchTransactions(accounts, fullRange, recentSinceMs),
          fetchSnapshots(accounts, fullRange, recentSinceMs),
          fetchInstitutions(accounts),
          fetchSecurities(),
          fetchTransfers(),
        ]);

        const refreshed = new Data();
        refreshed.accounts = accounts;
        refreshed.holdings = holdings;
        refreshed.securities = securitiesResult.securities;
        refreshed.items = items;
        refreshed.budgets = budgetsResult.budgets;
        refreshed.sections = budgetsResult.sections;
        refreshed.categories = budgetsResult.categories;
        refreshed.charts = chartsResult.charts;
        refreshed.splitTransactions = splitTransactionsResult.splitTransactions;
        refreshed.institutions = institutionsResult.institutions;
        refreshed.transactions = transactionsResult.transactions;
        refreshed.investmentTransactions = transactionsResult.investmentTransactions;
        refreshed.accountSnapshots = snapshotsResult.accountSnapshots;
        refreshed.holdingSnapshots = snapshotsResult.holdingSnapshots;
        refreshed.securitySnapshots = snapshotsResult.securitySnapshots;
        refreshed.transfers = transfersResult.transfers;
        refreshed.status.isInit = true;
        refreshed.status.isLoading = false;
        refreshed.status.isError = false;
        setData(refreshed);

        // If ANY of the warm-path fetches reported a network failure,
        // don't persist the partial result to IndexedDB — the existing
        // cache is still good; replacing it with a partial would
        // permanently lose the dictionaries that fell through to empty.
        // Same reason for skipping `writeLastSyncedAt` — the next warm
        // load needs the OLD timestamp so its refresh window still spans
        // the gap that just failed.
        const warmFetchFailed =
          budgetsResult.networkFailed ||
          chartsResult.networkFailed ||
          splitTransactionsResult.networkFailed ||
          transactionsResult.networkFailed ||
          snapshotsResult.networkFailed ||
          institutionsResult.networkFailed ||
          securitiesResult.networkFailed ||
          transfersResult.networkFailed;

        if (!warmFetchFailed) {
          indexedDb
            .clearAllData()
            .then(() => indexedDb.saveAllData(refreshed))
            .catch(console.error);
          writeLastSyncedAt(new Date());
        }
        return;
      }

      // ----- Cold start (no IndexedDB) — existing Stage 1/2/3 slicing -----

      const accountsPromise = fetchAccounts();

      const { networkFailed } = await accountsPromise;

      if (networkFailed) {
        // Even cold-start can hit a network failure; fall back to whatever
        // partial IndexedDB read returned (likely empty Data).
        setData((oldData) => {
          const newData = new Data(oldData);
          newData.status.isInit = true;
          newData.status.isLoading = false;
          newData.status.isError = true;
          return newData;
        });
        return;
      }

      // --- Stage 1: non-historical data (paint as soon as it lands).
      // Accounts/items, budgets/sections/categories, charts, institutions —
      // none of these are time-partitioned, so they finish quickly and let
      // the UI render the navigation + summary widgets before the heavy
      // snapshot/transaction fetches complete.
      const oldestDatePromise = getOldestTransactionDate();
      const budgetsPromise = fetchBudgets();
      const chartsPromise = fetchCharts();
      const institutionsPromise = accountsPromise.then((r) => fetchInstitutions(r.accounts));
      const securitiesPromise = fetchSecurities();
      const transfersPromise = fetchTransfers();

      const [
        { accounts, items },
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
      const { budgets, sections, categories } = stage1Budgets;
      const { charts } = stage1Charts;
      const { institutions } = stage1Institutions;
      const { securities } = stage1Securities;
      const { transfers } = stage1Transfers;

      const stage1 = new Data({
        accounts,
        items,
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

      // --- Stage 2: the most recent 2 months of historical data.
      // The current month + previous month covers what the active
      // dashboard / transactions table renders by default, so paint that
      // as soon as it's available rather than blocking on the full
      // history. Bounds are exclusive on both ends, matching the original
      // single-pass loop's `while (oldestDate < viewDate.getStartDate())`
      // semantics — months M with recentFrom < M.start < recentUntil are
      // fetched (i.e. current + previous).
      const currentViewDate = new ViewDate("month");
      const recentFrom = currentViewDate.clone().previous().previous().getStartDate();
      const recentUntil = currentViewDate.clone().next().getStartDate();
      const recentRange: FetchRange = { from: recentFrom, until: recentUntil };

      const [stage2Transactions, stage2SplitTxns, stage2Snapshots] = await Promise.all([
        fetchTransactions(accounts, recentRange),
        fetchSplitTransactions(),
        fetchSnapshots(accounts, recentRange),
      ]);
      const {
        transactions: recentTransactions,
        investmentTransactions: recentInvestmentTransactions,
      } = stage2Transactions;
      const { splitTransactions } = stage2SplitTxns;
      const {
        accountSnapshots: recentAccountSnapshots,
        holdingSnapshots: recentHoldingSnapshots,
        securitySnapshots: recentSecuritySnapshots,
      } = stage2Snapshots;

      const stage2 = new Data({
        accounts,
        items,
        budgets,
        sections,
        categories,
        charts,
        institutions,
        securities,
        transfers,
        transactions: recentTransactions,
        investmentTransactions: recentInvestmentTransactions,
        splitTransactions,
        accountSnapshots: recentAccountSnapshots,
        holdingSnapshots: recentHoldingSnapshots,
        securitySnapshots: recentSecuritySnapshots,
      });
      stage2.status.isInit = true;
      stage2.status.isLoading = true;
      stage2.status.isError = false;
      setData(stage2);

      // --- Stage 3: everything older. Fetch the rest of the historical
      // window (oldestTransactionDate → the month right before stage 2's
      // window) and merge it into the dictionaries from stage 2.
      // `olderUntil = 1-month-ago start` is exclusive — the older fetch
      // covers months M with olderFrom < M.start < olderUntil, which
      // begins one month earlier than stage 2's window so the two stages
      // tile cleanly with no overlap and no gap.
      const oldestDate = await oldestDatePromise;
      const defaultFrom = currentViewDate.clone().previous().previous().previous().getStartDate();
      const olderFrom = oldestDate && oldestDate < defaultFrom ? oldestDate : defaultFrom;
      const olderUntil = currentViewDate.clone().previous().getStartDate();

      const olderRange: FetchRange = { from: olderFrom, until: olderUntil };

      const finalData = new Data({
        accounts,
        items,
        budgets,
        sections,
        categories,
        charts,
        institutions,
        securities,
        transfers,
        transactions: recentTransactions,
        investmentTransactions: recentInvestmentTransactions,
        splitTransactions,
        accountSnapshots: recentAccountSnapshots,
        holdingSnapshots: recentHoldingSnapshots,
        securitySnapshots: recentSecuritySnapshots,
      });

      let stage3Transactions: FetchTransactionsResult | null = null;
      let stage3Snapshots: FetchSnapshotsResult | null = null;
      if (olderFrom < olderUntil) {
        // Splits aren't paged (stage 2 already fetched the full active set
        // in one shot), so stage 3 only covers transactions + snapshots.
        [stage3Transactions, stage3Snapshots] = await Promise.all([
          fetchTransactions(accounts, olderRange),
          fetchSnapshots(accounts, olderRange),
        ]);

        stage3Transactions.transactions.forEach((t, id) => finalData.transactions.set(id, t));
        stage3Transactions.investmentTransactions.forEach((t, id) =>
          finalData.investmentTransactions.set(id, t),
        );
        stage3Snapshots.accountSnapshots.forEach((s, id) => finalData.accountSnapshots.set(id, s));
        stage3Snapshots.holdingSnapshots.forEach((s, id) => finalData.holdingSnapshots.set(id, s));
        stage3Snapshots.securitySnapshots.forEach((s, id) =>
          finalData.securitySnapshots.set(id, s),
        );
      }

      finalData.status.isInit = true;
      finalData.status.isLoading = false;
      finalData.status.isError = false;
      setData(finalData);

      // Only persist when every cold-path fetch succeeded — same
      // semantics as the warm path. If anything failed, leave whatever
      // was in IndexedDB before this run alone and skip the timestamp
      // write so the next sync still treats this gap as un-pulled.
      const coldFetchFailed =
        stage1Budgets.networkFailed ||
        stage1Charts.networkFailed ||
        stage1Institutions.networkFailed ||
        stage1Securities.networkFailed ||
        stage1Transfers.networkFailed ||
        stage2Transactions.networkFailed ||
        stage2SplitTxns.networkFailed ||
        stage2Snapshots.networkFailed ||
        (stage3Transactions?.networkFailed ?? false) ||
        (stage3Snapshots?.networkFailed ?? false);

      console.log("[debug coldPath] coldFetchFailed=", coldFetchFailed,
        "stage1Budgets=", stage1Budgets.networkFailed,
        "stage1Transfers=", stage1Transfers.networkFailed,
        "stage2Transactions=", stage2Transactions.networkFailed,
        "stage2SplitTxns=", stage2SplitTxns.networkFailed,
        "stage2Snapshots=", stage2Snapshots.networkFailed,
        "stage3Transactions=", stage3Transactions?.networkFailed,
        "stage3Snapshots=", stage3Snapshots?.networkFailed,
        "finalData.transfers.size=", finalData.transfers.size,
        "finalData.transactions.size=", finalData.transactions.size,
      );

      if (!coldFetchFailed) {
        indexedDb
          .clearAllData()
          .then(() => {
            console.log("[debug coldPath] cleared, calling saveAllData");
            return indexedDb.saveAllData(finalData);
          })
          .then(() => console.log("[debug coldPath] saveAllData resolved"))
          .catch((e) => console.error("[debug coldPath] save chain error:", e));
        writeLastSyncedAt(new Date());
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
    removeLastSyncedAt();
    setData(new Data());
  }, [setData]);

  return { sync, clean };
};
