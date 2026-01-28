import { useCallback } from "react";
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
  useAppContext,
  call,
  cachedCall,
  budgetCalculatorLambda,
  balanceCalculatorLambda,
} from "client";
import {
  Account,
  InvestmentTransaction,
  Transaction,
  Budget,
  Section,
  Category,
  Item,
  BudgetDictionary,
  SectionDictionary,
  CategoryDictionary,
  Data,
  TransactionDictionary,
  InvestmentTransactionDictionary,
  ItemDictionary,
  AccountDictionary,
  SplitTransactionDictionary,
  SplitTransaction,
  ViewDate,
  getDateString,
  THIRTY_DAYS,
  ChartDictionary,
  Chart,
  SnapshotData,
  AccountSnapshot,
  HoldingSnapshot,
  AccountSnapshotDictionary,
  HoldingSnapshotDictionary,
} from "common";

const getOldestTransactionDate = async (): Promise<Date | undefined> => {
  const response = await call.get<OldestTransactionDateGetResponse>("/api/oldest-transaction-date");
  if (!response?.body) return undefined;
  return response.body ? new Date(response.body) : undefined;
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

      const promise = new Promise<void>(async (res) => {
        let response: ApiResponse<TransactionsGetResponse> | void;
        if (isRecent) {
          response = await call.get<TransactionsGetResponse>(path).catch(console.error);
        } else {
          response = await cachedCall<TransactionsGetResponse>(path);
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

        res();
      });

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
    });

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

  const response = await call.get<AccountsGetResponse>("/api/accounts");
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
  const response = await call.get<BudgetsGetResponse>("/api/budgets");
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

const fetchSnapshots = async (startDate?: Date): Promise<FetchSnapshotsResult> => {
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

  await call.get(path).then(({ body }) => {
    if (!body) return;
    const snapshots = body as SnapshotData[];

    snapshots.forEach((snapshot) => {
      if ("account" in snapshot) {
        const newSnapshot = new AccountSnapshot(snapshot);
        result.accountSnapshots.set(newSnapshot.snapshot.id, newSnapshot);
      } else if ("holding" in snapshot) {
        const newSnapshot = new HoldingSnapshot(snapshot);
        result.holdingSnapshots.set(newSnapshot.snapshot.id, newSnapshot);
      }
    });
  });

  return result;
};

interface FetchChartsResult {
  charts: ChartDictionary;
}

const fetchCharts = async (): Promise<FetchChartsResult> => {
  const result = { charts: new ChartDictionary() };
  const response = await call.get<ChartsGetResponse>("/api/charts");
  if (!response?.body) return result;
  response.body.forEach((e) => result.charts.set(e.chart_id, new Chart(e)));
  return result;
};

export const useSync = () => {
  const { user, setData, setDataStatus, viewDate } = useAppContext();
  const sync = useCallback(async () => {
    if (!user) return;
    setDataStatus("loading");

    try {
      const accountsPromise = fetchAccounts();
      const oldestDatePromise = getOldestTransactionDate();
      const transactionsPromise = Promise.all([accountsPromise, oldestDatePromise]).then(
        ([{ accounts }, oldestDate]) => fetchTransactions(accounts, oldestDate),
      );
      const splitTransactionsPromise = fetchSplitTransactions();
      const snapshotsPromise = oldestDatePromise.then((oldestDate) => fetchSnapshots(oldestDate));
      const budgetsPromise = fetchBudgets();
      const chartsPromise = fetchCharts();

      const [
        { accounts, items },
        { transactions, investmentTransactions },
        { splitTransactions },
        { accountSnapshots, holdingSnapshots },
        { budgets, sections, categories },
        { charts },
      ] = await Promise.all([
        accountsPromise,
        transactionsPromise,
        splitTransactionsPromise,
        snapshotsPromise,
        budgetsPromise,
        chartsPromise,
      ]);

      setData((oldData) => {
        const newData = new Data(oldData);

        newData.update({
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
        });

        const calculatedBudgets = budgetCalculatorLambda(newData, viewDate);
        const calculatedAccounts = balanceCalculatorLambda(newData, viewDate);

        newData.update({ ...calculatedBudgets, accounts: calculatedAccounts });

        return newData;
      });

      setDataStatus("success");
    } catch (err) {
      console.error(err);
      setDataStatus("error");
    }
  }, [setData, setDataStatus, user, viewDate]);

  const clean = useCallback(() => setData(new Data()), [setData]);

  return { sync, clean };
};
