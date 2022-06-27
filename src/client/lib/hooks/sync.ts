import { useRef, useCallback } from "react";
import { Transaction, Account } from "server";
import { useAppContext } from "client";
import { read } from "client";

/**
 * @returns a function that sets transactions and accounts states and a function that cleans them.
 */
export const useSync = () => {
  const { transactions, setTransactions, accounts, setAccounts } = useAppContext();
  const transactionsRef = useRef(transactions);
  const accountsRef = useRef(accounts);

  const sync = useCallback(() => {
    read<Transaction[]>("/api/transactions-stream", (r) => {
      const newTransactions = new Map(transactionsRef.current);
      r.data?.forEach((e) => newTransactions.set(e.transaction_id, e));
      setTransactions(newTransactions);
      transactionsRef.current = newTransactions;
    });
    read<Account[]>("/api/accounts-stream", (r) => {
      const newAccounts = new Map(accountsRef.current);
      r.data?.forEach((e) => newAccounts.set(e.account_id, e));
      setAccounts(newAccounts);
      accountsRef.current = newAccounts;
    });
  }, [setTransactions, setAccounts]);

  const clean = useCallback(() => {
    setTransactions(new Map());
    setAccounts(new Map());
  }, [setTransactions, setAccounts]);

  return { sync, clean };
};
