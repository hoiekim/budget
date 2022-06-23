import {
  useState,
  createContext,
  useContext,
  useRef,
  useEffect,
  Dispatch,
  SetStateAction,
} from "react";
import { Transaction, Account, MaskedUser } from "server";
import { read } from "client";

export interface ClientRouter {
  path: string;
  go: Dispatch<string>;
  forward: () => void;
  back: () => void;
}

export interface ContextType {
  transactions: Map<string, Transaction>;
  setTransactions: Dispatch<ContextType["transactions"]>;
  accounts: Map<string, Account>;
  setAccounts: Dispatch<ContextType["accounts"]>;
  user: MaskedUser | undefined;
  setUser: Dispatch<ContextType["user"]>;
  router: ClientRouter;
}

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
export const useSync = () => {
  const { transactions, setTransactions, accounts, setAccounts } = useContext(Context);
  const transactionsRef = useRef(transactions);
  const setTransactionsRef = useRef(setTransactions);
  const accountsRef = useRef(accounts);
  const setAccountsRef = useRef(setAccounts);

  useEffect(() => {
    transactionsRef.current = transactions;
  }, [transactions]);

  useEffect(() => {
    setTransactionsRef.current = setTransactions;
  }, [setTransactions]);

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  useEffect(() => {
    setAccountsRef.current = setAccounts;
  }, [setAccounts]);

  const sync = () => {
    read<Transaction[]>("/api/transactions-stream", (r) => {
      const newTransactions = new Map(transactionsRef.current);
      r.data?.forEach((e) => newTransactions.set(e.transaction_id, e));
      setTransactionsRef.current(newTransactions);
    });
    read<Account[]>("/api/accounts-stream", (r) => {
      const newAccounts = new Map(accountsRef.current);
      r.data?.forEach((e) => newAccounts.set(e.account_id, e));
      setAccountsRef.current(newAccounts);
    });
  };

  const clean = () => {
    setTransactionsRef.current(new Map());
    setAccountsRef.current(new Map());
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
