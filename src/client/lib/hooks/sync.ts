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
      const { items, added, removed, modified, investment } = data;

      setTransactions((oldTransactions) => {
        const newTransactions = new Map(oldTransactions);
        added.forEach((e) => newTransactions.set(e.transaction_id, e));
        modified.forEach((e) => {
          const oldTransaction = oldTransactions.get(e.transaction_id);
          if (oldTransaction) {
            newTransactions.set(e.transaction_id, { ...oldTransaction, ...e });
          }
        });
        removed.forEach((e) => newTransactions.delete(e.transaction_id));
        return newTransactions;
      });

      setInvestmentTransactions((oldInvestmentTransactions) => {
        const newInvestmentTransactions = new Map(oldInvestmentTransactions);
        investment.forEach((e) => {
          newInvestmentTransactions.set(e.investment_transaction_id, e);
        });
        return newInvestmentTransactions;
      });

      setItems((oldItems) => {
        const newItems = new Map(oldItems);
        items.forEach((item) => {
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
          newItems.set(item_id, item);
        });
        return newItems;
      });
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
        accounts.forEach((e) => newAccounts.set(e.account_id, e));
        return newAccounts;
      });

      setItems((oldItems) => {
        const newItems = new Map(oldItems);
        items.forEach((item) => {
          const { item_id } = item;
          newItems.set(item_id, item);
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
        const newBudgets: Budgets = new Map();
        budgets.forEach((e) => {
          const { budget_id } = e;
          const oldBudget = oldBudgets.get(budget_id);
          const amount = oldBudget?.amount;
          newBudgets.set(budget_id, { ...e, amount });
        });
        return newBudgets;
      });

      setSections((oldSections) => {
        const newSections: Sections = new Map();
        sections.forEach((e) => {
          const { section_id } = e;
          const oldSection = oldSections.get(section_id);
          const amount = oldSection?.amount;
          newSections.set(section_id, { ...e, amount });
        });
        return newSections;
      });

      setCategories((oldCategories) => {
        const newCategories: Categories = new Map();
        categories.forEach((e) => {
          const { category_id } = e;
          const oldCategorie = oldCategories.get(category_id);
          const amount = oldCategorie?.amount;
          newCategories.set(category_id, { ...e, amount });
        });
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
