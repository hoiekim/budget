import { createContext, useContext, Dispatch, SetStateAction } from "react";
import { Transaction, Account, Institution, MaskedUser, Item } from "server";
import { ClientRouter } from "client";

export type Transactions = Map<string | undefined, Transaction>;
export type Accounts = Map<string | undefined, Account>;
export type Institutions = Map<string | undefined, Institution>;
export type Items = Map<string, Item>;

export interface ContextType {
  transactions: Transactions;
  setTransactions: Dispatch<SetStateAction<Transactions>>;
  accounts: Accounts;
  setAccounts: Dispatch<SetStateAction<Accounts>>;
  institutions: Institutions;
  setInstitutions: Dispatch<SetStateAction<Institutions>>;
  items: Items;
  user: MaskedUser | undefined;
  setUser: Dispatch<SetStateAction<MaskedUser | undefined>>;
  router: ClientRouter;
}

export const Context = createContext<ContextType>({} as ContextType);

export const useAppContext = () => useContext(Context);
