import { Dispatch } from "react";
import { Transaction, AccountBase } from "plaid";

export interface User {
  id: string;
  username: string;
}

export interface ContextType {
  transactions: Transaction[];
  setTransactions: Dispatch<Transaction[]>;
  accounts: AccountBase[];
  setAccounts: Dispatch<AccountBase[]>;
  user: User | undefined;
  setUser: Dispatch<User>;
}
