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
  SplitTransaction,
  Chart,
  AccountSnapshot,
  HoldingSnapshot,
} from "common";
import { BudgetFamily, BudgetFamilyType } from "./models/BudgetFamily";

export class Dictionary<T = any, S extends Dictionary = any> extends Map<string, T> {
  toArray = () => Array.from(this.values());

  protected INPUT_ERROR_MESSAGE = "At least one key-value pair is required as input.";

  find = (predicate: (value: T, index: number, array: T[]) => void) => {
    return this.toArray().find(predicate);
  };

  findBy = (input: Partial<T>) => {
    if (!input || !Object.keys(input).length) {
      throw new Error(this.INPUT_ERROR_MESSAGE);
    }
    for (const key in input) {
      const typedKey = key as keyof T;
      const value = input[typedKey] as ValueOf<T>;
      const found = this.find((e) => e[typedKey] === value);
      if (found) return found;
    }
    return undefined;
  };

  filter = (predicate: (value: T, index: number) => boolean) => {
    const result: T[] = [];
    this.forEach((v, k) => {
      if (predicate(v, Number(k))) result.push(v);
    });
    return result;
  };

  filterBy = (input: Partial<T>) => {
    if (!input || !Object.keys(input).length) {
      throw new Error(this.INPUT_ERROR_MESSAGE);
    }
    let filtered = this.toArray();
    for (const key in input) {
      const typedKey = key as keyof T;
      const value = input[typedKey] as ValueOf<T>;
      filtered = filtered.filter((e) => e[typedKey] === value);
    }
    return filtered;
  };

  map = (callback: (value: T, key: string, map: Map<string, T>) => T) => {
    const clone = this.clone();
    clone.forEach((v, k, m) => m.set(k, callback(v, k, m)));
    return clone;
  };

  clone = () => new Dictionary<T>(this) as S extends any ? Dictionary<T> : S;

  override set = (key: string, value: T) => {
    if (environment === "server") {
      // TODO: currently the ability to store data in dictionary is disabled in server.
      // This is because server shouldn't store all users' data in memory, which will
      // cause infinite memory increase.
      console.warn("Dictionary.set() is disabled in server.");
      return this;
    }
    return super.set(key, value);
  };
}

export class AccountDictionary extends Dictionary<Account, AccountDictionary> {}
export class InstitutionDictionary extends Dictionary<Institution, InstitutionDictionary> {}

export class InvestmentTransactionDictionary extends Dictionary<
  InvestmentTransaction,
  InvestmentTransactionDictionary
> {}

export class SplitTransactionDictionary extends Dictionary<
  SplitTransaction,
  SplitTransactionDictionary
> {}

export class BudgetDictionary extends Dictionary<Budget, BudgetDictionary> {}
export class SectionDictionary extends Dictionary<Section, SectionDictionary> {}
export class CategoryDictionary extends Dictionary<Category, CategoryDictionary> {}
export class ItemDictionary extends Dictionary<Item, ItemDictionary> {}
export class ChartDictionary extends Dictionary<Chart, ChartDictionary> {}

export class AccountSnapshotDictionary extends Dictionary<
  AccountSnapshot,
  AccountSnapshotDictionary
> {}

export class HoldingSnapshotDictionary extends Dictionary<
  HoldingSnapshot,
  HoldingSnapshotDictionary
> {}

export class TransactionDictionary extends Dictionary<Transaction, TransactionDictionary> {
  filterByLabel = (input: Partial<TransactionLabel>) => {
    for (const key in input) {
      const typedKey = key as keyof TransactionLabel;
      const value = input[typedKey];
      return this.filter((e) => e.label[typedKey] === value);
    }
    throw new Error(this.INPUT_ERROR_MESSAGE);
  };
}

export const getBudgetClass = (type: BudgetFamilyType): typeof BudgetFamily => {
  return type === "budget" ? Budget : type === "section" ? Section : Category;
};

export const getBudgetDictionaryClass = (type: BudgetFamilyType): typeof Dictionary => {
  return type === "budget"
    ? BudgetDictionary
    : type === "section"
    ? SectionDictionary
    : CategoryDictionary;
};
