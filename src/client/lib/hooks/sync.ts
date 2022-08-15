import { useCallback, useMemo } from "react";
import {
  TransactionsStreamGetResponse,
  AccountsStreamGetResponse,
  BudgetsGetResponse,
} from "server";
import { useAppContext, read, call } from "client";

/**
 * @returns a function that sets transactions and accounts states and a function that cleans them.
 */
export const useSync = () => {
  const {
    user,
    setUser,
    setTransactions,
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
      const { added, removed, modified } = data;

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
    });
  }, [userLoggedIn, setTransactions]);

  type SyncAccounts = () => void;

  const syncAccounts = useCallback(() => {
    if (!userLoggedIn) return;

    read<AccountsStreamGetResponse>("/api/accounts-stream", ({ data }) => {
      if (!data) return;
      const { accounts, errors } = data;

      setAccounts((oldAccounts) => {
        const newAccounts = new Map(oldAccounts);
        accounts.forEach((e) => newAccounts.set(e.account_id, e));
        return newAccounts;
      });

      setUser((oldUser) => {
        const newItems = oldUser ? [...oldUser.items] : [];
        const newUser = oldUser && { ...oldUser, items: newItems };
        accounts.forEach((e) => {
          newItems.find((item) => {
            if (item.item_id === e.item_id) {
              delete item.plaidError;
              return true;
            }
            return false;
          });
        });
        errors.forEach((e) => {
          newItems.find((item) => {
            if (item.item_id === e.item_id) {
              item.plaidError = e;
              return true;
            }
            return false;
          });
        });
        return newUser;
      });
    });
  }, [userLoggedIn, setAccounts, setUser]);

  type SyncBudgets = () => void;

  const syncBudgets = useCallback(() => {
    if (!userLoggedIn) return;

    call.get<BudgetsGetResponse>("/api/budgets").then(({ data }) => {
      if (!data) return;
      const { budgets, sections, categories } = data;

      setBudgets((oldBudgets) => {
        const newBudgets = new Map(oldBudgets);
        Array.from(budgets.values()).forEach((e) => newBudgets.set(e.budget_id, e));
        return newBudgets;
      });

      setSections((oldSections) => {
        const newSections = new Map(oldSections);
        Array.from(sections.values()).forEach((e) => newSections.set(e.section_id, e));
        return newSections;
      });

      setCategories((oldCategories) => {
        const newCategories = new Map(oldCategories);
        Array.from(categories.values()).forEach((e) =>
          newCategories.set(e.category_id, e)
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
