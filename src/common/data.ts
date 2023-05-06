import {
  TransactionDictionary,
  Dictionary,
  Item,
  Budget,
  Section,
  Category,
  InvestmentTransaction,
  Account,
  Institution,
} from "common";

export const data = {
  institutions: new Dictionary<Institution>(),
  accounts: new Dictionary<Account>(),
  transactions: new TransactionDictionary(),
  investmentTransactions: new Dictionary<InvestmentTransaction>(),
  budgets: new Dictionary<Budget>(),
  sections: new Dictionary<Section>(),
  categories: new Dictionary<Category>(),
  items: new Dictionary<Item>(),
};
