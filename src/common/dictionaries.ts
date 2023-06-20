import {
  TransactionLabel,
  Transaction,
  ValueOf,
  environment,
  Account,
  Institution,
  InvestmentTransaction,
  Budget,
  Section,
  Category,
  Item,
} from "common";

export class Dictionary<T = any> extends Map<string, T> {
  toArray = () => Array.from(this.values());

  protected INPUT_ERROR_MESSAGE = "At least one key-value pair is required as input.";

  find = this.toArray().find;

  findBy = (input: Partial<T>) => {
    for (const key in input) {
      const typedKey = key as keyof T;
      const value = input[typedKey] as ValueOf<T>;
      return this.find((e) => e[typedKey] === value);
    }
    throw new Error(this.INPUT_ERROR_MESSAGE);
  };

  filter = this.toArray().filter;

  filterBy = (input: Partial<T>) => {
    for (const key in input) {
      const typedKey = key as keyof T;
      const value = input[typedKey] as ValueOf<T>;
      return this.filter((e) => e[typedKey] === value);
    }
    throw new Error(this.INPUT_ERROR_MESSAGE);
  };

  map = (callback: (value: T, key: string, map: Map<string, T>) => T) => {
    this.forEach((v, k, m) => m.set(k, callback(v, k, m)));
  };

  override set = (key: string, value: T) => {
    // TODO: currently the ability to store data in dictionary is disabled in server.
    // This is because server shouldn't store all users' data in memory, which will
    // cause infinite memory increase. In future implementation, the dictionary should
    // act as an abstraction for the database access.
    if (environment === "server") return this;
    return super.set(key, value);
  };
}

export class AccountDictionary extends Dictionary<Account> {}
export class InstitutionDictionary extends Dictionary<Institution> {}
export class InvestmentTransactionDictionary extends Dictionary<InvestmentTransaction> {}
export class BudgetDictionary extends Dictionary<Budget> {}
export class SectionDictionary extends Dictionary<Section> {}
export class CategoryDictionary extends Dictionary<Category> {}
export class ItemDictionary extends Dictionary<Item> {}

export class TransactionDictionary extends Dictionary<Transaction> {
  filterByLabel = (input: Partial<TransactionLabel>) => {
    for (const key in input) {
      const typedKey = key as keyof TransactionLabel;
      const value = input[typedKey];
      return this.filter((e) => e.label[typedKey] === value);
    }
    throw new Error(this.INPUT_ERROR_MESSAGE);
  };
}
