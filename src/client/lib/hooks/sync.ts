import { useCallback, useMemo } from "react";
import {
  TransactionsStreamGetResponse,
  AccountsStreamGetResponse,
  BudgetsGetResponse,
} from "server";
import { useAppContext, read, call } from "client";
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
} from "common";

/**
 * @returns a function that sets transactions and accounts states and a function that cleans them.
 */
export const useSync = () => {
  const { user, setData } = useAppContext();
  const userLoggedIn = !!user;

  type SyncTransactions = () => void;

  const syncTransactions = useCallback(() => {
    if (!userLoggedIn) return;

    read<TransactionsStreamGetResponse>("/api/transactions-stream", ({ body }) => {
      if (!body) return;
      const { items, transactions, investmentTransactions } = body;

      setData((oldData) => {
        const newData = new Data(oldData);

        if (transactions) {
          const newTransactions = new TransactionDictionary(newData.transactions);
          const { added, removed, modified } = transactions;
          added?.forEach((e) => {
            newTransactions.set(e.transaction_id, new Transaction(e));
          });
          modified?.forEach((e) => {
            const transaction = newTransactions.get(e.transaction_id);
            if (!transaction) return;
            const newTransaction = new Transaction({ ...transaction, ...e });
            newTransactions.set(newTransaction.id, newTransaction);
          });
          removed?.forEach((e) => {
            e.transaction_id && newTransactions.delete(e.transaction_id);
          });
          newData.transactions = newTransactions;
        }

        if (investmentTransactions) {
          const newInvestmentTransactions = new InvestmentTransactionDictionary(
            newData.investmentTransactions
          );
          const { added, removed, modified } = investmentTransactions;
          added?.forEach((e) => {
            const newInvestmentTransaction = new InvestmentTransaction(e);
            newInvestmentTransactions.set(newInvestmentTransaction.id, newInvestmentTransaction);
          });
          modified?.forEach((e) => {
            const investmentTransaction = newInvestmentTransactions.get(
              e.investment_transaction_id
            );
            if (!investmentTransaction) return;
            const newInvestmentTransaction = new InvestmentTransaction({
              ...investmentTransaction,
              ...e,
            });
            newInvestmentTransactions.set(newInvestmentTransaction.id, newInvestmentTransaction);
          });
          removed?.forEach((e) => {
            newInvestmentTransactions.delete(e.investment_transaction_id);
          });
          newData.investmentTransactions = newInvestmentTransactions;
        }

        if (items) {
          items?.forEach((item) => {
            const newItems = new ItemDictionary(newData.items);
            const { item_id, plaidError } = item;
            const existingItem = newItems.get(item_id);
            if (existingItem?.plaidError) {
              const oldPlaidError = existingItem?.plaidError;
              if (plaidError && plaidError.error_code !== oldPlaidError.error_code) {
                console.warn(`Multiple error is found in item: ${item_id}`);
                console.warn(oldPlaidError);
              }
              return;
            }
            newItems.set(item_id, new Item(item));
            newData.items = newItems;
          });
        }

        return newData;
      });
    });
  }, [userLoggedIn, setData]);

  type SyncAccounts = () => void;

  const syncAccounts = useCallback(() => {
    if (!userLoggedIn) return;

    read<AccountsStreamGetResponse>("/api/accounts-stream", ({ body }) => {
      if (!body) return;
      const { accounts, items } = body;

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
