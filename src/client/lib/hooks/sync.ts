import { useCallback, useMemo } from "react";
import {
  BudgetsGetResponse,
  TransactionsGetResponse,
  OldestTransactionDateGetResponse,
  ApiResponse,
  AccountsGetResponse,
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
} from "common";

/**
 * @returns a function that sets transactions and accounts states and a function that cleans them.
 */
export const useSync = () => {
  const { user, setData } = useAppContext();
  const userLoggedIn = !!user;

  type SyncTransactions = () => void;

  const syncTransactions = useCallback(async () => {
    if (!userLoggedIn) return;

    const oldestDatePromise = call
      .get<OldestTransactionDateGetResponse>("/api/oldest-transaction-date")
      .then(({ body }) => (body ? new Date(body) : undefined));

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

    while (oldestDate < viewDate.getStartDate()) {
      const params = new URLSearchParams();
      const startDate = viewDate.getStartDate();
      const endDate = viewDate.clone().next().getStartDate();
      params.append("start-date", getDateString(startDate));
      params.append("end-date", getDateString(endDate));
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

        const { transactions, investmentTransactions, splitTransactions } = response.body;
        transactions.forEach((t) => {
          updateStack.transactions.set(t.transaction_id, t);
        });
        investmentTransactions.forEach((t) => {
          updateStack.investmentTransactions.set(t.investment_transaction_id, t);
        });
        splitTransactions.forEach((t) => {
          updateStack.splitTransactions.set(t.split_transaction_id, t);
        });

        res();
      });

      promises.push(promise);
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
  }, [userLoggedIn, setData]);

  type SyncAccounts = () => void;

  const syncAccounts = useCallback(async () => {
    if (!userLoggedIn) return;

    const response = await call.get<AccountsGetResponse>("/api/accounts");
    if (!response?.body) return;
    const { accounts, items } = response.body;

    setData((oldData) => {
      const newData = new Data(oldData);

      const newAccounts = new AccountDictionary(newData.accounts);
      accounts.forEach((e) => newAccounts.set(e.account_id, new Account(e)));
      newData.accounts = newAccounts;

      const newItems = new ItemDictionary(newData.items);
      items.forEach((item) => {
        const { item_id } = item;
        newItems.set(item_id, new Item(item));
      });
      newData.items = newItems;

      return newData;
    });
  }, [userLoggedIn, setData]);

  type SyncBudgets = () => void;

  const syncBudgets = useCallback(() => {
    if (!userLoggedIn) return;

    call.get<BudgetsGetResponse>("/api/budgets").then(({ body }) => {
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

  type SyncAll = () => void;

  const syncAll = useCallback(() => {
    syncTransactions();
    syncAccounts();
    syncBudgets();
  }, [syncTransactions, syncAccounts, syncBudgets]);

  type Sync = {
    all: SyncAll;
    transactions: SyncTransactions;
    accounts: SyncAccounts;
    budgets: SyncBudgets;
  };

  const sync: Sync = useMemo(
    () => ({
      all: syncAll,
      transactions: syncTransactions,
      accounts: syncAccounts,
      budgets: syncBudgets,
    }),
    [syncAll, syncTransactions, syncAccounts, syncBudgets]
  );

  const clean = useCallback(() => setData(new Data()), [setData]);

  return { sync, clean };
};
