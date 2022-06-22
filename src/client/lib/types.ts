import { Dispatch } from "react";
import { Transaction, Account } from "server";

export interface User {
  id: string;
  username: string;
}

export interface ClientRouter {
  path: string;
  go: Dispatch<string>;
  forward: () => void;
  back: () => void;
}

export interface ContextType {
  transactions: Transaction[];
  setTransactions: Dispatch<Transaction[]>;
  accounts: Account[];
  setAccounts: Dispatch<Account[]>;
  user: User | undefined;
  setUser: Dispatch<User | undefined>;
  router: ClientRouter;
}
