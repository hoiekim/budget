import { useCallback } from "react";
import {
  ViewDate,
  getDateString,
  THIRTY_DAYS,
  JSONInstitution,
  JSONSnapshotData,
  LocalDate,
} from "common";
import {
  BudgetsGetResponse,
  TransactionsGetResponse,
  OldestTransactionDateGetResponse,
  ApiResponse,
  AccountsGetResponse,
  SplitTransactionsGetResponse,
  ChartsGetResponse,
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
  InstitutionDictionary,
  Institution,
  useDebounce,
  indexedDb,
} from "client";

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

const fetchTransactions = async (
  accounts: AccountDictionary,
  startDate?: Date,
): Promise<FetchTransactionsResult> => {
  const result = {
    transactions: new TransactionDictionary(),
    investmentTransactions: new InvestmentTransactionDictionary(),
  };

  const transactionsApiPath = "/api/transactions";
  const viewDate = new ViewDate("month");
  const twoMonthAgoViewDate = viewDate.clone().previous().previous();
  let oldestDate = twoMonthAgoViewDate.previous().getStartDate();
  oldestDate = startDate && startDate < oldestDate ? startDate : oldestDate;

  const promises: Promise<void>[] = [];

  while (oldestDate < viewDate.getStartDate()) {
    accounts?.forEach((a) => {
      const params = new URLSearchParams();
      const startDate = viewDate.getStartDate();
      const endDate = viewDate.clone().next().getStartDate();
      params.append("start-date", getDateString(startDate));
      params.append("end-date", getDateString(endDate));
      params.append("account-id", a.id);
      const path = transactionsApiPath + "?" + params.toString();
      const isRecent = new Date().getTime() - endDate.getTime() < THIRTY_DAYS;

      const promise = (async () => {
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
      })();

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
}

const fetchAccounts = async (): Promise<FetchAccountsResult> => {
  const result = {
    accounts: new AccountDictionary(),
    items: new ItemDictionary(),
  };

  const response = await call.get<AccountsGetResponse>("/api/accounts").catch(console.error);
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
}

const fetchSnapshots = async (
  accounts: AccountDictionary,
  startDate?: Date,
): Promise<FetchSnapshotsResult> => {
  const result = {
    accountSnapshots: new AccountSnapshotDictionary(),
    holdingSnapshots: new HoldingSnapshotDictionary(),
  };

  const params = new URLSearchParams();
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 2);
  if (startDate) params.append("start-date", getDateString(startDate));
  params.append("end-date", getDateString(endDate));
  const path = "/api/snapshots?" + params.toString();

  await call
    .get(path)
    .then(({ body }) => {
      if (!body) return;
      const snapshots = body as JSONSnapshotData[];

      snapshots.forEach((snapshot) => {
        if ("account" in snapshot) {
          const account = accounts.get(snapshot.account.account_id) || {};
          snapshot.account = { ...account, ...snapshot.account };
          const newSnapshot = new AccountSnapshot(snapshot);
          result.accountSnapshots.set(newSnapshot.snapshot.id, newSnapshot);
        } else if ("holding" in snapshot) {
          const newSnapshot = new HoldingSnapshot(snapshot);
          result.holdingSnapshots.set(newSnapshot.snapshot.id, newSnapshot);
        }
      });
    })
    .catch(console.error);

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
      indexedDb
        .loadAllData()
        .then((data) => {
          // do not update data because API data is already available
          if (data.status.isInit) return;
          data.status.isInit = true;
          data.status.isLoading = false;
          data.status.isError = false;
          setData(data);
        })
        .catch((error) => {
          console.error(error);
          setData((oldData) => {
            const newData = new Data(oldData);
            newData.status.isInit = true;
            newData.status.isLoading = false;
            newData.status.isError = true;
            return newData;
          });
        });

      const accountsPromise = fetchAccounts();
      const oldestDatePromise = getOldestTransactionDate();
      const transactionsPromise = Promise.all([accountsPromise, oldestDatePromise]).then(
        ([{ accounts }, oldestDate]) => fetchTransactions(accounts, oldestDate),
      );
      const splitTransactionsPromise = fetchSplitTransactions();
      const snapshotsPromise = Promise.all([accountsPromise, oldestDatePromise]).then(
        ([{ accounts }, oldestDate]) => fetchSnapshots(accounts, oldestDate),
      );
      const budgetsPromise = fetchBudgets();
      const chartsPromise = fetchCharts();
      const institutionsPromise = accountsPromise.then((r) => fetchInstitutions(r.accounts));

      const [
        { accounts, items },
        { transactions, investmentTransactions },
        { splitTransactions },
        { accountSnapshots, holdingSnapshots },
        { budgets, sections, categories },
        { charts },
        { institutions },
      ] = await Promise.all([
        accountsPromise,
        transactionsPromise,
        splitTransactionsPromise,
        snapshotsPromise,
        budgetsPromise,
        chartsPromise,
        institutionsPromise,
      ]);

      const newData = new Data({
        accounts,
        items,
        transactions,
        splitTransactions,
        investmentTransactions,
        accountSnapshots,
        holdingSnapshots,
        budgets,
        sections,
        categories,
        charts,
        institutions,
      });

      newData.status.isInit = true;
      newData.status.isLoading = false;
      newData.status.isError = false;

      setData(newData);

      indexedDb
        .clearAllData()
        .then(() => indexedDb.saveAllData(newData))
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
