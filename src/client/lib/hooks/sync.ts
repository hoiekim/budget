import { useCallback } from "react";
import { TransactionsResponse, AccountsResponse } from "server";
import { useAppContext, read } from "client";

/**
 * @returns a function that sets transactions and accounts states and a function that cleans them.
 */
export const useSync = () => {
  const { user, setUser, setTransactions, setAccounts } = useAppContext();
  const userLoggedIn = !!user;

  const sync = useCallback(() => {
    if (!userLoggedIn) return;

    read<TransactionsResponse>("/api/transactions-stream", ({ data }) => {
      if (!data) return;
      const { added, removed, modified } = data;

      setTransactions((oldTransactions) => {
        const newTransactions = new Map(oldTransactions);
        [...added, ...modified].forEach((e) => newTransactions.set(e.transaction_id, e));
        removed.forEach((e) => newTransactions.delete(e.transaction_id));
        return newTransactions;
      });
    });

    read<AccountsResponse>("/api/accounts-stream", ({ data }) => {
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
  }, [userLoggedIn, setUser, setTransactions, setAccounts]);

  const clean = useCallback(() => {
    setTransactions(new Map());
    setAccounts(new Map());
  }, [setTransactions, setAccounts]);

  return { sync, clean };
};
