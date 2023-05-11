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
import { InvestmentTransaction, Transaction, Budget, Section, Category } from "common";

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
          added?.forEach((e) => newData.set(e.transaction_id, e));
          modified?.forEach((e) => {
            const data = oldData.get(e.transaction_id);
            if (data) newData.set(e.transaction_id, new Transaction({ ...data, ...e }));
          });
          removed?.forEach((e) => newData.delete(e.transaction_id));
          return newData;
        });
      }

      if (investmentTransactions) {
        setInvestmentTransactions((oldData) => {
          const newData = new Map(oldData);
          const { added, removed, modified } = investmentTransactions;
          added?.forEach((e) => newData.set(e.investment_transaction_id, e));
          modified?.forEach((e) => {
            const data = oldData.get(e.investment_transaction_id);
            if (!data) return;
            const newTransaction = new InvestmentTransaction({ ...data, ...e });
            newData.set(e.investment_transaction_id, newTransaction);
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
            newItems.set(item_id, item);
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

      setBudgets(() => {
        const m = (e: Budget): [string, Budget] => [e.budget_id, new Budget(e)];
        const newBudgets: Budgets = new Map(budgets.map(m));
        return newBudgets;
      });

      setSections(() => {
        const m = (e: Section): [string, Section] => [e.section_id, new Section(e)];
        const newSections: Sections = new Map(sections.map(m));
        return newSections;
      });

      setCategories(() => {
        const m = (e: Category): [string, Category] => [e.category_id, new Category(e)];
        const newCategories: Categories = new Map(categories.map(m));
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
