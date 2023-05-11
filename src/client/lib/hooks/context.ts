import { createContext, useContext, Dispatch, SetStateAction } from "react";
import { MaskedUser } from "server";
import {
  Transaction,
  InvestmentTransaction,
  Account,
  Budget,
  Section,
  Category,
  Interval,
  Item,
  Institution,
  ViewDate,
} from "common";
import { ClientRouter } from "client";

export type Transactions = Map<string | undefined, Transaction>;
export type InvestmentTransactions = Map<string | undefined, InvestmentTransaction>;
export type Accounts = Map<string | undefined, Account>;
export type Institutions = Map<string | undefined, Institution>;
export type Items = Map<string, Item>;

export type Budgets = Map<string, Budget>;
export type Sections = Map<string, Section>;
export type Categories = Map<string, Category>;

export interface ContextType {
  transactions: Transactions;
  setTransactions: Dispatch<SetStateAction<Transactions>>;
  investmentTransactions: InvestmentTransactions;
  setInvestmentTransactions: Dispatch<SetStateAction<InvestmentTransactions>>;
  accounts: Accounts;
  setAccounts: Dispatch<SetStateAction<Accounts>>;
  institutions: Institutions;
  setInstitutions: Dispatch<SetStateAction<Institutions>>;
  items: Items;
  setItems: Dispatch<SetStateAction<Items>>;
  user: MaskedUser | undefined;
  setUser: Dispatch<SetStateAction<MaskedUser | undefined>>;
  router: ClientRouter;
  budgets: Budgets;
  setBudgets: Dispatch<SetStateAction<Budgets>>;
  sections: Sections;
  setSections: Dispatch<SetStateAction<Sections>>;
  categories: Categories;
  setCategories: Dispatch<SetStateAction<Categories>>;
  selectedInterval: Interval;
  setSelectedInterval: Dispatch<SetStateAction<Interval>>;
  viewDate: ViewDate;
  setViewDate: Dispatch<SetStateAction<ViewDate>>;
}

export const Context = createContext<ContextType>({} as ContextType);

export const useAppContext = () => useContext(Context);
