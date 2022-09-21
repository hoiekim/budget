import { useCallback, useMemo } from "react";
import {
  TransactionsStreamGetResponse,
  AccountsStreamGetResponse,
  BudgetsGetResponse,
} from "server";
import { useAppContext, read, call, Accounts } from "client";

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
          if (oldItem?.plaidError && plaidError) {
            console.warn(`Multiple error is found in item: ${item_id}`);
            console.warn(plaidError);
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

      setAccounts(() => {
        const newAccounts: Accounts = new Map();
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
        const newBudgets = new Map(oldBudgets);
        budgets.forEach((e) => newBudgets.set(e.budget_id, e));
        return newBudgets;
      });

      setSections((oldSections) => {
        const newSections = new Map(oldSections);
        sections.forEach((e) => newSections.set(e.section_id, e));
        return newSections;
      });

      setCategories((oldCategories) => {
        const newCategories = new Map(oldCategories);
        categories.forEach((e) => newCategories.set(e.category_id, e));
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
