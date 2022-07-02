import { createContext, useContext, Dispatch } from "react";
import { Transaction, Account, Institution, MaskedUser } from "server";
import { ClientRouter } from "client";

export type Transactions = Map<string, Transaction>;
export type Accounts = Map<string, Account>;
export type Institutions = Map<string, Institution>;

export interface ContextType {
  transactions: Transactions;
  setTransactions: Dispatch<Transactions>;
  accounts: Accounts;
  setAccounts: Dispatch<Accounts>;
  institutions: Institutions;
  setInstitutions: Dispatch<Institutions>;
  user: MaskedUser | undefined;
  setUser: Dispatch<MaskedUser | undefined>;
  router: ClientRouter;
}

export const Context = createContext<ContextType>({} as ContextType);

export const useAppContext = () => useContext(Context);
