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
} from "client";

// Browsers cap concurrent fetches per origin (~6 on HTTP/1.1) and queueing
// hundreds of `fetch`/`cache.add` calls at once triggers
// ERR_INSUFFICIENT_RESOURCES — which silently aborts `cache.add` and defeats
// the Cache API benefit for older months. Gate snapshot fetches through a
// shared Queue so at most 6 are in flight at any time.
const snapshotFetchQueue = new Queue({ maxInflight: 6 });

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
): Promise<FetchTransactionsResult> => {
  const result = {
    transactions: new TransactionDictionary(),
    investmentTransactions: new InvestmentTransactionDictionary(),
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
      const path = transactionsApiPath + "?" + params.toString();
      const isRecent = new Date().getTime() - endDate.getTime() < THIRTY_DAYS;

      const fetchTransactionsForAccount = async () => {
        let response: ApiResponse<TransactionsGetResponse> | void;
        if (isRecent) {
          response = await call.get<TransactionsGetResponse>(path).catch(console.error);
        } else {
          response = await cachedCall<TransactionsGetResponse>(path).catch(console.error);
        }
        if (!response?.body) return;

        const { transactions, investmentTransactions } = response.body;
        transactions.forEach((t) => {
          result.transactions.set(t.transaction_id, new Transaction(t));
        });
        investmentTransactions.forEach((t) => {
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

  return result;
};

interface FetchSplitTransactionsResult {
  splitTransactions: SplitTransactionDictionary;
}

const fetchSplitTransactions = async (): Promise<FetchSplitTransactionsResult> => {
  const result = { splitTransactions: new SplitTransactionDictionary() };

  await call
    .get<SplitTransactionsGetResponse>("/api/split-transactions")
    .then(({ body: splitTransactions }) => {
      if (!splitTransactions) return;
      splitTransactions.forEach((t) => {
        result.splitTransactions.set(t.split_transaction_id, new SplitTransaction(t));
      });
    })
    .catch(console.error);

  return result;
};

interface FetchAccountsResult {
  accounts: AccountDictionary;
  items: ItemDictionary;
  networkFailed: boolean;
}

const fetchAccounts = async (): Promise<FetchAccountsResult> => {
  const result = {
    accounts: new AccountDictionary(),
    items: new ItemDictionary(),
    networkFailed: false,
  };

  const response = await call.get<AccountsGetResponse>("/api/accounts").catch(console.error);
  if (response?.status === "error") return { ...result, networkFailed: true };
  if (!response?.body) return result;

  const { accounts, items } = response.body;

  accounts.forEach((e) => result.accounts.set(e.account_id, new Account(e)));
  items.forEach((item) => result.items.set(item.item_id, new Item(item)));

  return result;
};

interface FetchBudgetsResult {
  budgets: BudgetDictionary;
  sections: SectionDictionary;
  categories: CategoryDictionary;
}

const fetchBudgets = async (): Promise<FetchBudgetsResult> => {
  const response = await call.get<BudgetsGetResponse>("/api/budgets").catch(console.error);
  if (!response?.body)
    return {
      budgets: new BudgetDictionary(),
      sections: new SectionDictionary(),
      categories: new CategoryDictionary(),
    };

  const { budgets, sections, categories } = response.body;

  const result = {
    budgets: new BudgetDictionary(),
    sections: new SectionDictionary(),
    categories: new CategoryDictionary(),
  };

  budgets.forEach((e) => result.budgets.set(e.budget_id, new Budget(e)));
  sections.forEach((e) => result.sections.set(e.section_id, new Section(e)));
  categories.forEach((e) => result.categories.set(e.category_id, new Category(e)));

  return result;
};

interface FetchSnapshotsResult {
  accountSnapshots: AccountSnapshotDictionary;
  holdingSnapshots: HoldingSnapshotDictionary;
  securitySnapshots: SecuritySnapshotDictionary;
}

const fetchSnapshots = async (
  accounts: AccountDictionary,
  range: FetchRange,
): Promise<FetchSnapshotsResult> => {
  const result = {
    accountSnapshots: new AccountSnapshotDictionary(),
    holdingSnapshots: new HoldingSnapshotDictionary(),
    securitySnapshots: new SecuritySnapshotDictionary(),
  };

  const ingestSnapshot = (snapshot: JSONSnapshotData) => {
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
  // once-per-month for shared security snapshots. Older months go through
  // `cachedCall` so they only hit the network on first load; the most
  // recent month always re-fetches so today's data stays fresh.
  const snapshotsApiPath = "/api/snapshots";
  const viewDate = new ViewDate("month");
  while (viewDate.getStartDate() >= range.until) viewDate.previous();

  const promises: Promise<void>[] = [];

  while (range.from < viewDate.getStartDate()) {
    const monthStart = viewDate.getStartDate();
    const monthEnd = viewDate.clone().next().getStartDate();
    const startStr = getDateString(monthStart);
    const endStr = getDateString(monthEnd);
    const isRecent = new Date().getTime() - monthEnd.getTime() < THIRTY_DAYS;

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
          if (!response?.body) return;
          response.body.forEach(ingestSnapshot);
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
        if (!response?.body) return;
        response.body.forEach(ingestSnapshot);
      }),
    );

    viewDate.previous();
  }

  await Promise.all(promises);

  return result;
};

interface FetchChartsResult {
  charts: ChartDictionary;
}

const fetchCharts = async (): Promise<FetchChartsResult> => {
  const result = { charts: new ChartDictionary() };
  const response = await call.get<ChartsGetResponse>("/api/charts").catch(console.error);
  if (!response?.body) return result;
  response.body.forEach((e) => result.charts.set(e.chart_id, new Chart(e)));
  return result;
};

interface FetchInstitutionResult {
  institutions: InstitutionDictionary;
}

const fetchInstitutions = async (accounts: AccountDictionary): Promise<FetchInstitutionResult> => {
  const result = { institutions: new InstitutionDictionary() };
  const promises = accounts.toArray().map(async ({ institution_id }) => {
    if (institution_id === "Unknown") return;
    const response = await cachedCall<JSONInstitution>(
      `/api/institution?id=${institution_id}`,
    ).catch(console.error);
    if (response) result.institutions.set(institution_id, new Institution(response.body));
  });

  await Promise.all(promises);

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
      const isWarm = !!cached && cached.accounts.size > 0;

      if (isWarm && cached) {
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
        // can show a refresh indicator while the current-month fetch
        // settles.
        cached.status.isInit = true;
        cached.status.isLoading = true;
        cached.status.isError = false;
        setData(cached);

        const { accounts, items } = await accountsPromise;
        // Update accounts/items in case any were added/removed since the
        // last visit — these are small payloads, cheap to refresh on
        // every sync.
        accounts.forEach((a) => cached.accounts.set(a.id, a));
        items.forEach((it) => cached.items.set(it.id, it));

        // Refresh only the current month (transactions + snapshots).
        // Older history doesn't retroactively change, so the cache is
        // authoritative for everything pre-current-month.
        const now = new ViewDate("month");
        const currentMonthRange: FetchRange = {
          from: now.getStartDate(),
          until: now.clone().next().getStartDate(),
        };

        // Refresh in parallel: budgets/sections/categories, charts,
        // split-transactions, current-month transactions, current-month
        // snapshots, institutions for any new accounts.
        const [
          { budgets, sections, categories },
          { charts },
          { splitTransactions },
          { transactions: newTransactions, investmentTransactions: newInvestmentTransactions },
          {
            accountSnapshots: newAccountSnapshots,
            holdingSnapshots: newHoldingSnapshots,
            securitySnapshots: newSecuritySnapshots,
          },
          { institutions },
        ] = await Promise.all([
          fetchBudgets(),
          fetchCharts(),
          fetchSplitTransactions(),
          fetchTransactions(accounts, currentMonthRange),
          fetchSnapshots(accounts, currentMonthRange),
          fetchInstitutions(accounts),
        ]);

        // Merge fresh small payloads (entire dictionaries replaced).
        const refreshed = new Data(cached);
        refreshed.accounts = accounts;
        refreshed.items = items;
        refreshed.budgets = budgets;
        refreshed.sections = sections;
        refreshed.categories = categories;
        refreshed.charts = charts;
        refreshed.splitTransactions = splitTransactions;
        refreshed.institutions = institutions;

        // Merge current-month transactions/snapshots into cached history.
        // Same-id updates overwrite (Plaid may revise a recent txn);
        // older months in the cache are preserved.
        newTransactions.forEach((t, id) => refreshed.transactions.set(id, t));
        newInvestmentTransactions.forEach((t, id) =>
          refreshed.investmentTransactions.set(id, t),
        );
        newAccountSnapshots.forEach((s, id) => refreshed.accountSnapshots.set(id, s));
        newHoldingSnapshots.forEach((s, id) => refreshed.holdingSnapshots.set(id, s));
        newSecuritySnapshots.forEach((s, id) => refreshed.securitySnapshots.set(id, s));

        refreshed.status.isInit = true;
        refreshed.status.isLoading = false;
        refreshed.status.isError = false;
        setData(refreshed);

        indexedDb
          .clearAllData()
          .then(() => indexedDb.saveAllData(refreshed))
          .catch(console.error);
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

      const [
        { accounts, items },
        { budgets, sections, categories },
        { charts },
        { institutions },
      ] = await Promise.all([
        accountsPromise,
        budgetsPromise,
        chartsPromise,
        institutionsPromise,
      ]);

      const stage1 = new Data({
        accounts,
        items,
        budgets,
        sections,
        categories,
        charts,
        institutions,
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

      const [
        { transactions: recentTransactions, investmentTransactions: recentInvestmentTransactions },
        { splitTransactions },
        {
          accountSnapshots: recentAccountSnapshots,
          holdingSnapshots: recentHoldingSnapshots,
          securitySnapshots: recentSecuritySnapshots,
        },
      ] = await Promise.all([
        fetchTransactions(accounts, recentRange),
        fetchSplitTransactions(),
        fetchSnapshots(accounts, recentRange),
      ]);

      const stage2 = new Data({
        accounts,
        items,
        budgets,
        sections,
        categories,
        charts,
        institutions,
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
        transactions: recentTransactions,
        investmentTransactions: recentInvestmentTransactions,
        splitTransactions,
        accountSnapshots: recentAccountSnapshots,
        holdingSnapshots: recentHoldingSnapshots,
        securitySnapshots: recentSecuritySnapshots,
      });

      if (olderFrom < olderUntil) {
        const [
          { transactions: olderTransactions, investmentTransactions: olderInvestmentTransactions },
          {
            accountSnapshots: olderAccountSnapshots,
            holdingSnapshots: olderHoldingSnapshots,
            securitySnapshots: olderSecuritySnapshots,
          },
        ] = await Promise.all([
          fetchTransactions(accounts, olderRange),
          fetchSnapshots(accounts, olderRange),
        ]);

        olderTransactions.forEach((t, id) => finalData.transactions.set(id, t));
        olderInvestmentTransactions.forEach((t, id) =>
          finalData.investmentTransactions.set(id, t),
        );
        olderAccountSnapshots.forEach((s, id) => finalData.accountSnapshots.set(id, s));
        olderHoldingSnapshots.forEach((s, id) => finalData.holdingSnapshots.set(id, s));
        olderSecuritySnapshots.forEach((s, id) => finalData.securitySnapshots.set(id, s));
      }

      finalData.status.isInit = true;
      finalData.status.isLoading = false;
      finalData.status.isError = false;
      setData(finalData);

      indexedDb
        .clearAllData()
        .then(() => indexedDb.saveAllData(finalData))
        .catch(console.error);
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

  const clean = useCallback(() => setData(new Data()), [setData]);

  return { sync, clean };
};
