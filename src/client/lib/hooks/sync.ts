import { useCallback, useMemo } from "react";
import {
  BudgetsGetResponse,
  TransactionsGetResponse,
  OldestTransactionDateGetResponse,
  ApiResponse,
  AccountsGetResponse,
  SplitTransactionsGetResponse,
  ChartsGetResponse,
} from "server";
import { useAppContext, call, cachedCall } from "client";
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

/**
 * @returns a function that sets transactions and accounts states and a function that cleans them.
 */
export const useSync = () => {
  const { user, setData } = useAppContext();
  const userLoggedIn = !!user;

  type SyncTransactions = (accounts?: AccountDictionary) => void;

  const getOldestTransactionDate = useCallback(async (): Promise<Date | undefined> => {
    if (!userLoggedIn) return undefined;

    const response = await call.get<OldestTransactionDateGetResponse>(
      "/api/oldest-transaction-date"
    );
    if (!response?.body) return undefined;

    return response.body ? new Date(response.body) : undefined;
  }, [userLoggedIn]);

  const syncTransactions = useCallback(
    async (accounts?: AccountDictionary, oldestDatePromise?: Promise<Date | undefined>) => {
      if (!userLoggedIn) return;

      const transactionsApiPath = "/api/transactions";
      const viewDate = new ViewDate("month");
      const twoMonthAgoViewDate = viewDate.clone().previous().previous();
      let oldestDate = twoMonthAgoViewDate.clone().previous().getStartDate();

      const updateStack = {
        transactions: new TransactionDictionary(),
        investmentTransactions: new InvestmentTransactionDictionary(),
        splitTransactions: new SplitTransactionDictionary(),
      };

      const promises: Promise<void>[] = [];

      const getSplitTransactions = call
        .get<SplitTransactionsGetResponse>("/api/split-transactions")
        .then(({ body: splitTransactions }) => {
          if (!splitTransactions) return;
          splitTransactions.forEach((t) => {
            updateStack.splitTransactions.set(t.split_transaction_id, t);
          });
        });

      promises.push(getSplitTransactions);

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
            let response: ApiResponse<TransactionsGetResponse> | undefined;
            if (isRecent) {
              response = await call.get<TransactionsGetResponse>(path);
            } else {
              response = await cachedCall<TransactionsGetResponse>(path);
            }
            if (!response?.body) return;

            const { transactions, investmentTransactions } = response.body;
            transactions.forEach((t) => {
              updateStack.transactions.set(t.transaction_id, t);
            });
            investmentTransactions.forEach((t) => {
              updateStack.investmentTransactions.set(t.investment_transaction_id, t);
            });

            res();
          });

          promises.push(promise);
        });

        viewDate.previous();

        if (viewDate.getStartDate() <= oldestDate) {
          oldestDate = (await oldestDatePromise) || oldestDate;
        }
      }

      await Promise.all(promises);

      setData((oldData) => {
        const newData = new Data(oldData);
        const { transactions, investmentTransactions, splitTransactions } = updateStack;

        if (transactions.size) {
          const newTransactions = new TransactionDictionary(newData.transactions);
          transactions.forEach((e) => {
            newTransactions.set(e.transaction_id, new Transaction(e));
          });
          newData.transactions = newTransactions;
        }

        if (investmentTransactions.size) {
          const newInvestmentTransactions = new InvestmentTransactionDictionary(
            newData.investmentTransactions
          );
          investmentTransactions.forEach((e) => {
            const newInvestmentTransaction = new InvestmentTransaction(e);
            newInvestmentTransactions.set(newInvestmentTransaction.id, newInvestmentTransaction);
          });
          newData.investmentTransactions = newInvestmentTransactions;
        }

        if (splitTransactions.size) {
          const newSplitTransactions = new SplitTransactionDictionary(newData.splitTransactions);
          splitTransactions.forEach((e) => {
            newSplitTransactions.set(e.split_transaction_id, new SplitTransaction(e));
          });
          newData.splitTransactions = newSplitTransactions;
        }

        return newData;
      });
    },
    [userLoggedIn, setData]
  );

  type SyncAccounts = () => Promise<AccountDictionary>;

  const syncAccounts = useCallback(async () => {
    const newAccounts = new AccountDictionary();

    if (!userLoggedIn) return newAccounts;

    const response = await call.get<AccountsGetResponse>("/api/accounts");
    if (!response?.body) return newAccounts;

    const { accounts, items } = response.body;

    accounts.forEach((e) => newAccounts.set(e.account_id, new Account(e)));
    const newItems = new ItemDictionary();
    items.forEach((item) => newItems.set(item.item_id, new Item(item)));

    setData((oldData) => {
      const newData = new Data(oldData);
      newData.accounts = newAccounts;
      newData.items = newItems;
      return newData;
    });

    return newAccounts.clone() as AccountDictionary;
  }, [userLoggedIn, setData]);

  type SyncBudgets = () => void;

  const syncBudgets = useCallback(async () => {
    if (!userLoggedIn) return;

    await call.get<BudgetsGetResponse>("/api/budgets").then(({ body }) => {
      if (!body) return;
      const { budgets, sections, categories } = body;

      setData((oldData) => {
        const newData = new Data(oldData);

        const newBudgets: BudgetDictionary = new BudgetDictionary(newData.budgets);
        budgets.forEach((e) => {
          const { budget_id } = e;
          const newBudget = new Budget(e);
          const existing = newBudgets.get(budget_id);
          if (existing) {
            newBudget.sorted_amount = existing.sorted_amount;
            newBudget.unsorted_amount = existing.unsorted_amount;
            newBudget.number_of_unsorted_items = existing.number_of_unsorted_items;
            newBudget.rolled_over_amount = existing.rolled_over_amount;
          }
          newBudgets.set(budget_id, newBudget);
        });
        newData.budgets = newBudgets;

        const newSections = new SectionDictionary(newData.sections);
        sections.forEach((e) => {
          const { section_id } = e;
          const newSection = new Section(e);
          const existing = newSections.get(section_id);
          if (existing) {
            newSection.sorted_amount = existing.sorted_amount;
            newSection.unsorted_amount = existing.unsorted_amount;
            newSection.number_of_unsorted_items = existing.number_of_unsorted_items;
            newSection.rolled_over_amount = existing.rolled_over_amount;
          }
          newSections.set(section_id, newSection);
        });
        newData.sections = newSections;

        const newCategories = new CategoryDictionary(newData.categories);
        categories.forEach((e) => {
          const { category_id } = e;
          const newCategory = new Category(e);
          const existing = newCategories.get(category_id);
          if (existing) {
            newCategory.sorted_amount = existing.sorted_amount;
            newCategory.unsorted_amount = existing.unsorted_amount;
            newCategory.number_of_unsorted_items = existing.number_of_unsorted_items;
            newCategory.rolled_over_amount = existing.rolled_over_amount;
          }
          newCategories.set(category_id, newCategory);
        });
        newData.categories = newCategories;

        return newData;
      });
    });
  }, [userLoggedIn, setData]);

  type SyncCharts = () => void;

  const syncCharts = useCallback(async () => {
    if (!userLoggedIn) return;

    await call.get<ChartsGetResponse>("/api/charts").then(({ body }) => {
      if (!body) return;

      setData((oldData) => {
        const newData = new Data(oldData);

        const newCharts = new ChartDictionary(newData.charts);
        body.forEach((e) => {
          const { chart_id } = e;
          const newChart = new Chart(e);
          newCharts.set(chart_id, newChart);
        });
        newData.charts = newCharts;

        return newData;
      });
    });
  }, [userLoggedIn, setData]);

  const syncSnapshots = useCallback(
    async (oldestDatePromise: Promise<Date | undefined>) => {
      if (!userLoggedIn) return;
      const params = new URLSearchParams();
      const startDate = await oldestDatePromise;
      const endDate = new Date();
      params.append("start-date", getDateString(startDate));
      params.append("end-date", getDateString(endDate));
      const path = "/api/snapshots?" + params.toString();

      await call.get(path).then(({ body }) => {
        if (!body) return;
        const snapshots = body as SnapshotData[];
        setData((oldData) => {
          const newData = new Data(oldData);

          const newAccountSnapshots = new AccountSnapshotDictionary(newData.accountSnapshots);
          const newHoldingSnapshots = new HoldingSnapshotDictionary(newData.holdingSnapshots);

          snapshots.forEach((snapshot) => {
            if ("account" in snapshot) {
              const newSnapshot = new AccountSnapshot(snapshot);
              newAccountSnapshots.set(snapshot.snapshot.id, newSnapshot);
            } else if ("holding" in snapshot) {
              const newSnapshot = new HoldingSnapshot(snapshot);
              newHoldingSnapshots.set(snapshot.snapshot.id, newSnapshot);
            }
          });

          newData.accountSnapshots = newAccountSnapshots;
          newData.holdingSnapshots = newHoldingSnapshots;

          return newData;
        });
      });
    },
    [userLoggedIn, setData]
  );

  type SyncAll = () => Promise<void>[];

  const syncAll = useCallback(() => {
    const accountsPromise = syncAccounts();
    const oldestDatePromise = getOldestTransactionDate();
    const transactionsPromise = accountsPromise.then((accounts) =>
      syncTransactions(accounts, oldestDatePromise)
    );
    return [transactionsPromise, syncBudgets(), syncCharts(), syncSnapshots(oldestDatePromise)];
  }, [
    syncTransactions,
    syncAccounts,
    syncBudgets,
    syncCharts,
    syncSnapshots,
    getOldestTransactionDate,
  ]);

  type Sync = {
    all: SyncAll;
    transactions: SyncTransactions;
    accounts: SyncAccounts;
    budgets: SyncBudgets;
    charts: SyncCharts;
  };

  const sync: Sync = useMemo(
    () => ({
      all: syncAll,
      transactions: syncTransactions,
      accounts: syncAccounts,
      budgets: syncBudgets,
      charts: syncCharts,
    }),
    [syncAll, syncTransactions, syncAccounts, syncBudgets, syncCharts]
  );

  const clean = useCallback(() => setData(new Data()), [setData]);

  return { sync, clean };
};
