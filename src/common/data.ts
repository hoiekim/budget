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
  SplitTransactionDictionary,
  ChartDictionary,
} from "common";

export class Data {
  institutions = new InstitutionDictionary();
  accounts = new AccountDictionary();
  transactions = new TransactionDictionary();
  investmentTransactions = new InvestmentTransactionDictionary();
  splitTransactions = new SplitTransactionDictionary();
  budgets = new BudgetDictionary();
  sections = new SectionDictionary();
  categories = new CategoryDictionary();
  items = new ItemDictionary();
  charts = new ChartDictionary();

  constructor(init?: Partial<Data>) {
    assign(this, init);
  }

  update = (init?: Partial<Data>) => {
    assign(this, init);
  };
}

export const globalData = new Data();
