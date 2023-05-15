import { useCallback, useMemo } from "react";
import {
  TransactionsStreamGetResponse,
  AccountsStreamGetResponse,
  BudgetsGetResponse,
} from "server";
import {
  useAppContext,
  read,
  call,
  Accounts,
  Budgets,
  Sections,
  Categories,
} from "client";
import {
  Account,
  InvestmentTransaction,
  Transaction,
  Budget,
  Section,
  Category,
  Item,
} from "common";

/**
 * @returns a function that sets transactions and accounts states and a function that cleans them.
 */
export const useSync = () => {
  const {
    user,
    setItems,
    setTransactions,
    setInvestmentTransactions,
    setAccounts,
    setBudgets,
    setSections,
    setCategories,
  } = useAppContext();
  const userLoggedIn = !!user;

  type SyncTransactions = () => void;

  const syncTransactions = useCallback(() => {
    if (!userLoggedIn) return;

    read<TransactionsStreamGetResponse>("/api/transactions-stream", ({ data }) => {
      if (!data) return;
      const { items, transactions, investmentTransactions } = data;

      if (transactions) {
        setTransactions((oldData) => {
          const newData = new Map(oldData);
          const { added, removed, modified } = transactions;
          added?.forEach((e) => newData.set(e.transaction_id, new Transaction(e)));
          modified?.forEach((e) => {
            const data = oldData.get(e.transaction_id);
            if (!data) return;
            const newTransaction = new Transaction({ ...data, ...e });
            newData.set(newTransaction.id, newTransaction);
          });
          removed?.forEach((e) => newData.delete(e.transaction_id));
          return newData;
        });
      }

      if (investmentTransactions) {
        setInvestmentTransactions((oldData) => {
          const newData = new Map(oldData);
          const { added, removed, modified } = investmentTransactions;
          added?.forEach((e) => {
            const newTransaction = new InvestmentTransaction(e);
            newData.set(newTransaction.id, newTransaction);
          });
          modified?.forEach((e) => {
            const data = oldData.get(e.investment_transaction_id);
            if (!data) return;
            const newTransaction = new InvestmentTransaction({ ...data, ...e });
            newData.set(newTransaction.id, newTransaction);
          });
          removed?.forEach((e) => newData.delete(e.investment_transaction_id));
          return newData;
        });
      }

      if (items) {
        setItems((oldItems) => {
          const newItems = new Map(oldItems);
          items?.forEach((item) => {
            const { item_id, plaidError } = item;
            const oldItem = oldItems.get(item_id);
            if (oldItem?.plaidError) {
              const oldPlaidError = oldItem?.plaidError;
              if (plaidError && plaidError.error_code !== oldPlaidError.error_code) {
                console.warn(`Multiple error is found in item: ${item_id}`);
                console.warn(oldPlaidError);
              }
              return;
            }
            newItems.set(item_id, new Item(item));
          });
          return newItems;
        });
      }
    });
  }, [userLoggedIn, setItems, setTransactions, setInvestmentTransactions]);

  type SyncAccounts = () => void;

  const syncAccounts = useCallback(() => {
    if (!userLoggedIn) return;

    read<AccountsStreamGetResponse>("/api/accounts-stream", ({ data }) => {
      if (!data) return;
      const { accounts, items } = data;

      setAccounts((oldAccounts) => {
        const newAccounts: Accounts = new Map(oldAccounts);
        accounts.forEach((e) => newAccounts.set(e.account_id, new Account(e)));
        return newAccounts;
      });

      setItems((oldItems) => {
        const newItems = new Map(oldItems);
        items.forEach((item) => {
          const { item_id } = item;
          newItems.set(item_id, new Item(item));
        });
        return newItems;
      });
    });
  }, [userLoggedIn, setItems, setAccounts]);

  type SyncBudgets = () => void;

  const syncBudgets = useCallback(() => {
    if (!userLoggedIn) return;

    call.get<BudgetsGetResponse>("/api/budgets").then(({ data }) => {
      if (!data) return;
      const { budgets, sections, categories } = data;

      setBudgets((oldBudgets) => {
        const newBudgets: Budgets = new Map(
          budgets.map((e) => {
            const { budget_id } = e;
            const newBudget = new Budget(e);
            const old = oldBudgets.get(budget_id);
            if (old) {
              newBudget.sorted_amount = old.sorted_amount;
              newBudget.unsorted_amount = old.unsorted_amount;
              newBudget.rolled_over_amount = old.rolled_over_amount;
            }
            return [budget_id, newBudget];
          })
        );
        return newBudgets;
      });

      setSections((oldSections) => {
        const newSections: Sections = new Map(
          sections.map((e) => {
            const { section_id } = e;
            const newSection = new Section(e);
            const old = oldSections.get(section_id);
            if (old) {
              newSection.sorted_amount = old.sorted_amount;
              newSection.unsorted_amount = old.unsorted_amount;
              newSection.rolled_over_amount = old.rolled_over_amount;
            }
            return [section_id, newSection];
          })
        );
        return newSections;
      });

      setCategories((oldCategories) => {
        const newCategories: Categories = new Map(
          categories.map((e) => {
            const { category_id } = e;
            const newCategory = new Category(e);
            const old = oldCategories.get(category_id);
            if (old) {
              newCategory.sorted_amount = old.sorted_amount;
              newCategory.unsorted_amount = old.unsorted_amount;
              newCategory.rolled_over_amount = old.rolled_over_amount;
            }
            return [category_id, newCategory];
          })
        );
        return newCategories;
      });
    });
  }, [userLoggedIn, setBudgets, setSections, setCategories]);

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

  const clean = useCallback(() => {
    setTransactions(new Map());
    setAccounts(new Map());
    setBudgets(new Map());
    setSections(new Map());
    setCategories(new Map());
  }, [setTransactions, setAccounts, setBudgets, setSections, setCategories]);

  return { sync, clean };
};
