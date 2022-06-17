import { Dispatch } from "react";
import { Transaction, Account } from "server"

export interface User {
  id: string;
  username: string;
}

export interface ContextType {
  transactions: Transaction[];
  setTransactions: Dispatch<Transaction[]>;
  accounts: Account[];
  setAccounts: Dispatch<Account[]>;
  user: User | undefined;
  setUser: Dispatch<User | undefined>;
}
