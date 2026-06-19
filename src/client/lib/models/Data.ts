import { assign, ValueOf, environment } from "common";
import { Account } from "./Account";
import { Holding, Institution, Security, Status } from "./miscellaneous";
import { BudgetFamily, BudgetFamilyType } from "./BudgetFamily";
import { Transaction } from "./Transaction";
import { InvestmentTransaction } from "./InvestmentTransaction";
import { SplitTransaction } from "./SplitTransaction";
import { Budget } from "./Budget";
import { Section } from "./Section";
import { Category } from "./Category";
import { Item } from "./Item";
import { Chart } from "./Chart";
import { AccountSnapshot, HoldingSnapshot, SecuritySnapshot } from "./Snapshot";
import type { TransferPair } from "server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class Dictionary<T = any, S extends Dictionary<T> = any> extends Map<string, T> {
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
    clone.forEach((v, k, m) => m.set(k, callback(v as T, k, m)));
    return clone;
  };

  clone = () => new Dictionary<T>(this) as S;

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
export class HoldingDictionary extends Dictionary<Holding, HoldingDictionary> {}
export class SecurityDictionary extends Dictionary<Security, SecurityDictionary> {}

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

export class SecuritySnapshotDictionary extends Dictionary<
  SecuritySnapshot,
  SecuritySnapshotDictionary
> {}

export class TransactionDictionary extends Dictionary<Transaction, TransactionDictionary> {}

/**
 * Pair-keyed dictionary of transfers. Keys are pair_id; values are the
 * server's TransferPair (with status + the two transactions). Maintains
 * a private `pivot: transaction_id → pair` so consumers can resolve "is
 * this transaction part of any pair?" in O(1) via getByTransactionId(),
 * without standing up a parallel map at the Data level. Overrides
 * `set`/`delete` to keep the pivot in sync with the primary map.
 *
 * Suggested and confirmed pairs live in the same dictionary — consumers
 * filter on `pair.status` at the point of use (matches the suggested-
 * vs-confirmed category-label pattern already in use elsewhere).
 */
export class TransferDictionary extends Map<string, TransferPair> {
  private pivot = new Map<string, TransferPair>();

  constructor(init?: Iterable<readonly [string, TransferPair]> | null) {
    super(init as Iterable<readonly [string, TransferPair]> | undefined);
    // Build the pivot from the entries the base Map constructor just
    // ingested. The entries went through Map.prototype.set (not our
    // override), so the pivot wasn't populated incrementally.
    this.forEach((pair) => {
      pair.transactions.forEach((t) => this.pivot.set(t.transaction_id, pair));
    });
  }

  getByTransactionId = (transaction_id: string): TransferPair | undefined => {
    return this.pivot.get(transaction_id);
  };

  override set(pair_id: string, pair: TransferPair): this {
    const prev = super.get(pair_id);
    if (prev) {
      prev.transactions.forEach((t) => this.pivot.delete(t.transaction_id));
    }
    pair.transactions.forEach((t) => this.pivot.set(t.transaction_id, pair));
    return super.set(pair_id, pair);
  }

  override delete(pair_id: string): boolean {
    const prev = super.get(pair_id);
    if (prev) {
      prev.transactions.forEach((t) => this.pivot.delete(t.transaction_id));
    }
    return super.delete(pair_id);
  }
}

export const getBudgetClass = (type: BudgetFamilyType): typeof BudgetFamily => {
  return type === "budget" ? Budget : type === "section" ? Section : Category;
};

export const getBudgetDictionaryClass = (
  type: BudgetFamilyType,
): typeof BudgetDictionary | typeof SectionDictionary | typeof CategoryDictionary => {
  return type === "budget"
    ? BudgetDictionary
    : type === "section"
      ? SectionDictionary
      : CategoryDictionary;
};

export class Data {
  status = new Status();

  institutions = new InstitutionDictionary();
  accounts = new AccountDictionary();
  holdings = new HoldingDictionary();
  securities = new SecurityDictionary();
  transactions = new TransactionDictionary();
  investmentTransactions = new InvestmentTransactionDictionary();
  splitTransactions = new SplitTransactionDictionary();
  budgets = new BudgetDictionary();
  sections = new SectionDictionary();
  categories = new CategoryDictionary();
  items = new ItemDictionary();
  charts = new ChartDictionary();
  accountSnapshots = new AccountSnapshotDictionary();
  holdingSnapshots = new HoldingSnapshotDictionary();
  securitySnapshots = new SecuritySnapshotDictionary();

  /** All transfer pairs (suggested + confirmed), keyed by pair_id.
   *  Read by `getBudgetData` / `getSankeyData` (filtering to
   *  `status==="confirmed"`) to skip confirmed-transfer halves from
   *  spent/income aggregation, and by `TransactionsTable` /
   *  `TransactionProperties` etc. for bundled-row and Confirm/Reject UI.
   *  Populated by `useSync`'s `fetchTransfers()` on cold/warm load,
   *  mutated in-place via `useTransfers()` action methods. */
  transfers = new TransferDictionary();

  constructor(init?: Partial<Data>) {
    assign(this, init);
  }

  update = (init: Partial<Data>) => {
    assign(this, init);
  };
}

export const globalData = new Data();
