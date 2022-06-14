import { useState, createContext, useContext, useRef, useEffect } from "react";
import { Transaction, AccountBase } from "plaid";
import { ContextType, read, Cache } from "client";

export const useLocalStorage = <T>(key: string, initialValue: T) => {
  const [storedValue, setStoredValue] = useState(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(error);
      return initialValue;
    }
  });

  const setValue = (value: any | ((val: any) => any)) => {
    try {
      const valueToStore =
        value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      window.localStorage.setItem(key, JSON.stringify(valueToStore));
    } catch (error) {
      console.error(error);
    }
  };

  return [
    storedValue as T,
    setValue as React.Dispatch<React.SetStateAction<T>>,
  ] as const;
};

export const Context = createContext<ContextType>({} as ContextType);

/**
 * @returns a function that sets transactions and accounts states.
 */
export const useSynchronizer = () => {
  const { setTransactions, setAccounts } = useContext(Context);
  const setTransactionsRef = useRef(setTransactions);
  const setAccountsRef = useRef(setAccounts);

  useEffect(() => {
    setTransactionsRef.current = setTransactions;
  }, [setTransactions]);

  useEffect(() => {
    setAccountsRef.current = setAccounts;
  }, [setAccounts]);

  const synchronize = () => {
    read<Transaction[]>("/api/transactions-stream", (r) => {
      r.data?.forEach((e) => Cache.transactions.set(e.transaction_id, e));
      const array = Array.from(Cache.transactions.values());
      setTransactionsRef.current(array);
    });
    read<AccountBase[]>("/api/accounts-stream", (r) => {
      r.data?.forEach((e) => Cache.accounts.set(e.account_id, e));
      const array = Array.from(Cache.accounts.values());
      setAccountsRef.current(array);
    });
  };

  return synchronize;
};
