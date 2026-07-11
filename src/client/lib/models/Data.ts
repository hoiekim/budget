import { assign, ValueOf, environment } from "common";
import { StoreName } from "client/lib/indexed-db/accessor";
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
import type { MutableModel } from "client/lib/hooks/useMutate";
import type { StoredModel } from "client/lib/indexed-db/service";

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
 * this transaction part of any pair?" in O(1) via the `byTransactionId`
 * accessor, without standing up a parallel map at the Data level. Overrides
 * `set`/`delete` to keep the pivot in sync with the primary map.
 *
 * Suggested and confirmed pairs live in the same dictionary. The
 * `byTransactionId` accessor exposes the per-status membership predicates
 * (`hasSuggested`/`hasConfirmed`) so the calc layer reads "is this a
 * confirmed transfer half?" as one method call instead of spelling out
 * a `pair?.status === "confirmed"` check at every site (matches the
 * suggested-vs-confirmed category-label pattern already in use
 * elsewhere). `.get` returns the pair for consumers that need its body.
 */
export class TransferDictionary extends Dictionary<TransferPair, TransferDictionary> {
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

  /**
   * Per-transaction_id accessors over the pivot. `get`/`has` answer
   * membership; `hasSuggested`/`hasConfirmed` answer "is this transaction
   * a half of a pair in that status?" in O(1) without the caller spelling
   * out the `.status === …` check. Note: keys are real transaction_ids;
   * synthetic split transactions (`SplitTransaction.toTransaction()`)
   * carry the split's own id, so a lookup on a synthetic split returns
   * undefined — callers guard the split pass on the PARENT's id.
   */
  byTransactionId = {
    get: (transaction_id: string): TransferPair | undefined => this.pivot.get(transaction_id),
    has: (transaction_id: string): boolean => this.pivot.has(transaction_id),
    hasSuggested: (transaction_id: string): boolean =>
      this.pivot.get(transaction_id)?.status === "suggested",
    hasConfirmed: (transaction_id: string): boolean =>
      this.pivot.get(transaction_id)?.status === "confirmed",
  };

  // Dictionary's `set` is an arrow-function field, not a prototype
  // method, so `super.set` from our own arrow field doesn't resolve
  // (TS2855). Call `Map.prototype.set` directly — same effect as
  // bypassing Dictionary's server-side guard, which doesn't apply to
  // transfers (this is FE-only code).
  override set = (pair_id: string, pair: TransferPair): this => {
    const prev = Map.prototype.get.call(this, pair_id) as TransferPair | undefined;
    if (prev) {
      prev.transactions.forEach((t) => this.pivot.delete(t.transaction_id));
    }
    pair.transactions.forEach((t) => this.pivot.set(t.transaction_id, pair));
    Map.prototype.set.call(this, pair_id, pair);
    return this;
  };

  override delete = (pair_id: string): boolean => {
    const prev = Map.prototype.get.call(this, pair_id) as TransferPair | undefined;
    if (prev) {
      prev.transactions.forEach((t) => this.pivot.delete(t.transaction_id));
    }
    return Map.prototype.delete.call(this, pair_id);
  };
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

  /** Fetch a Model's dictionary from this `Data`. Overloads keep call
   *  sites precisely typed (`data.dictOf(Chart)` → `ChartDictionary`,
   *  etc.); the impl dispatches on the class ref. Extend both the
   *  overload list AND the impl switch to wire a new model into
   *  `useMutate`.
   *
   *  Central mapping for `useMutate` — the model-to-slot dispatch lives
   *  here alongside the field declarations, so a new model only needs
   *  entries in `dictOf` / `storeNameOf` / `set` below (no per-model
   *  static plumbing on the Model class itself). */
  dictOf(Model: typeof Chart): ChartDictionary;
  dictOf(Model: typeof Transaction): TransactionDictionary;
  dictOf(Model: typeof InvestmentTransaction): InvestmentTransactionDictionary;
  dictOf(Model: typeof HoldingSnapshot): HoldingSnapshotDictionary;
  dictOf<T extends StoredModel>(Model: MutableModel<T>): Dictionary<T>;
  dictOf<T extends StoredModel>(Model: MutableModel<T>): Dictionary<T> {
    if (Model === Chart) return this.charts as unknown as Dictionary<T>;
    if (Model === Transaction) return this.transactions as unknown as Dictionary<T>;
    if (Model === InvestmentTransaction)
      return this.investmentTransactions as unknown as Dictionary<T>;
    if (Model === HoldingSnapshot) return this.holdingSnapshots as unknown as Dictionary<T>;
    throw new Error(`Data.dictOf: no dictionary for ${Model.name}`);
  }

  /** IDB `StoreName` for a Model — same inline mapping shape as
   *  `dictOf`. Kept here (not on the Model class) so all model →
   *  slot / store wiring lives in this one file. */
  storeNameOf<T extends StoredModel>(Model: MutableModel<T>): StoreName {
    if (Model === Chart) return StoreName.charts;
    if (Model === Transaction) return StoreName.transactions;
    if (Model === InvestmentTransaction) return StoreName.investmentTransactions;
    if (Model === HoldingSnapshot) return StoreName.holdingSnapshots;
    throw new Error(`Data.storeNameOf: no store for ${Model.name}`);
  }

  /** Write a Dictionary back to its slot. `instanceof` dispatch so
   *  callers don't need to pass the Model class again — the Dictionary
   *  knows its own type via its constructor. */
  set(dict: Dictionary): void {
    if (dict instanceof ChartDictionary) this.charts = dict;
    else if (dict instanceof TransactionDictionary) this.transactions = dict;
    else if (dict instanceof InvestmentTransactionDictionary)
      this.investmentTransactions = dict;
    else if (dict instanceof HoldingSnapshotDictionary) this.holdingSnapshots = dict;
    else throw new Error(`Data.set: unknown dictionary ${dict.constructor.name}`);
  }
}

export const globalData = new Data();
