import {
  useState,
  createContext,
  useContext,
  useRef,
  useEffect,
  Dispatch,
  SetStateAction,
} from "react";
import { ContextType, read, Cache } from "client";
import { Transaction, Account } from "server";

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
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      window.localStorage.setItem(key, JSON.stringify(valueToStore));
    } catch (error) {
      console.error(error);
    }
  };

  return [storedValue as T, setValue as Dispatch<SetStateAction<T>>] as const;
};

export const Context = createContext<ContextType>({} as ContextType);

/**
 * @returns a function that sets transactions and accounts states and a function that cleans them.
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

  const sync = () => {
    read<Transaction[]>("/api/transactions-stream", (r) => {
      r.data?.forEach((e) => Cache.transactions.set(e.transaction_id, e));
      const array = Array.from(Cache.transactions.values());
      setTransactionsRef.current(array);
    });
    read<Account[]>("/api/accounts-stream", (r) => {
      r.data?.forEach((e) => Cache.accounts.set(e.account_id, e));
      const array = Array.from(Cache.accounts.values());
      setAccountsRef.current(array);
    });
  };

  const clean = () => {
    setTransactionsRef.current([]);
    setAccountsRef.current([]);
  };

  return { sync, clean };
};

export const useRouter = () => {
  const { pathname } = window.location;
  const [path, setPath] = useState(pathname);

  useEffect(() => {
    if (pathname !== path) window.history.pushState("", "", path);
  }, [pathname, path]);

  const { forward, back } = window.history;

  return { path, go: setPath, forward, back };
};
