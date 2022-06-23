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
  const accountsRef = useRef(accounts);

  const sync = () => {
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
  };

  const clean = () => {
    setTransactions(new Map());
    setAccounts(new Map());
  };

  return { sync, clean };
};

let isRouterRegistered = false;

export const useRouter = (): ClientRouter => {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    if (!isRouterRegistered) {
      window.addEventListener("popstate", () => setPath(window.location.pathname), false);
      isRouterRegistered = true;
    }
  }, []);

  const go = (target: string) => {
    if (window.location.pathname !== target) {
      window.history.pushState("", "", target);
      setPath(target);
    }
  };

  const { forward, back } = window.history;

  return { path, go, forward, back };
};
