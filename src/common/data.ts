import {
  TransactionDictionary,
  AccountDictionary,
  InstitutionDictionary,
  InvestmentTransactionDictionary,
  BudgetDictionary,
  SectionDictionary,
  CategoryDictionary,
  ItemDictionary,
  assign,
} from "common";

export class Data {
  institutions = new InstitutionDictionary();
  accounts = new AccountDictionary();
  transactions = new TransactionDictionary();
  investmentTransactions = new InvestmentTransactionDictionary();
  budgets = new BudgetDictionary();
  sections = new SectionDictionary();
  categories = new CategoryDictionary();
  items = new ItemDictionary();

  constructor(init?: Partial<Data>) {
    assign(this, init);
  }

  update = (init?: Partial<Data>) => {
    assign(this, init);
  };
}

export const globalData = new Data();
