import { assign, getYearMonthString, isDate, isUndefined, LocalDate, ViewDate } from "common";
import { Status } from "./miscellaneous";
import { SplitTransactionDictionary } from "./Data";
import { SplitTransaction } from "./SplitTransaction";

export class Calculations {
  status = new Status();

  balanceData = new BalanceData();
  budgetData = new BudgetData();
  capacityData = new CapacityData();
  transactionFamilies = new TransactionFamilies();
  holdingsValueData = new HoldingsValueData();

  constructor(init?: Partial<Calculations>) {
    assign(this, init);
  }

  update = (init: Partial<Calculations>) => {
    assign(this, init);
  };
}

/**
 * Note: this type is used when saving data in IndexedDB
 * so it must be a plain object without fancy method functions.
 * @example
 * {
 *    "2026-01": 100,
 *    "2026-02": 150
 * }
 */
export type AmountByMonth = { [k: string]: number };

/**
 * Helper class to abstract balance history write & read processes.
 */
export class BalanceHistory {
  private data: AmountByMonth = {};
  private range?: [Date, Date];

  constructor(data?: AmountByMonth) {
    if (data) this.data = data;
  }

  private getKey = (date: Date) => getYearMonthString(date);
  private getDate = (key: string) => new LocalDate(`${key}-15`);

  getData = (): AmountByMonth => ({ ...this.data });
  getRange = (): [Date, Date] | undefined => this.range && [...this.range];

  get startDate() {
    return this.range && new ViewDate("month", this.range[0]);
  }

  get endDate() {
    return this.range && new ViewDate("month", this.range[1]);
  }

  set = (date: Date, amount: number) => {
    if (!this.range) this.range = [date, date];
    else if (this.range[1] < date) this.range[1] = date;
    else if (date < this.range[0]) this.range[0] = date;
    this.data[this.getKey(date)] = amount;
  };

  get = (date: Date): number | undefined => {
    return this.data[this.getKey(date)];
  };

  /**
   * Add amount to the specified date's position.
   * If amount doesn't exist in the position, assume it was 0.
   */
  add = (date: Date, amount: number) => {
    const existing = this.get(date) || 0;
    this.set(date, existing + amount);
  };

  /**
   * Returns an array of balance history. Each value represents balance amount.
   * Values are 0-indexed where 0 is the month of the given `viewDate`,
   * 1 is the previous month, and so on.
   */
  toArray = (viewDate: ViewDate) => {
    const result: number[] = [];
    Object.entries(this.data).forEach(([key, value]) => {
      const date = this.getDate(key);
      if (!isDate(date)) return;
      const span = viewDate.getSpanFrom(date);
      if (span >= 0) result[span] = value;
    });
    return result;
  };
}

/**
 * Balance history stored by `accountId` and `date`.
 * @example
 * const balanceData = new BalanceData();
 * const accountId = "a1b2c3";
 * const date = new Date("2026-01-01");
 *
 * balanceData.set(accountId, date, 100);
 * let balanceAmount = balanceData.get(accountId, date);
 * console.log(balanceAmount); // 100
 *
 * balanceData.add(accountId, date, 50);
 * balanceAmount = balanceData.get(accountId, date);
 * console.log(balanceAmount); // 150
 */
export class BalanceData {
  private data = new Map<string, BalanceHistory>();

  get size() {
    return this.data.size;
  }

  getEntries = () => Array.from(this.data.entries());

  set(accountId: string, balanceHistory: BalanceHistory): void;
  set(accountId: string, date: Date, amount: number): void;
  set(accountId: string, dateOrBalanceHistory: Date | BalanceHistory, amount?: number) {
    if (isDate(dateOrBalanceHistory) && !isUndefined(amount)) {
      const date = dateOrBalanceHistory;
      if (!this.data.has(accountId)) this.data.set(accountId, new BalanceHistory());
      const accountData = this.data.get(accountId)!;
      accountData.set(date!, amount!);
    } else if (dateOrBalanceHistory instanceof BalanceHistory) {
      const balanceHistory = dateOrBalanceHistory;
      this.data.set(accountId, balanceHistory);
    }
  }

  get(accountId: string): BalanceHistory;
  get(accountId: string, date: Date): number | undefined;
  get(accountId: string, date?: Date) {
    if (!this.data.has(accountId)) this.data.set(accountId, new BalanceHistory());
    const accountData = this.data.get(accountId)!;
    if (date === undefined) return accountData;
    return accountData.get(date);
  }

  add = (accountId: string, date: Date, amount: number) => {
    this.get(accountId).add(date, amount);
  };

  forEach = (cb: (history: BalanceHistory, id: string) => void) => this.data.forEach(cb);
}

export class CapacitySummary {
  children_total = 0;
  grand_children_total = 0;
}

export class CapacityData extends Map<string, CapacitySummary> {
  override get = (id: string) => {
    const existing = super.get(id);
    if (existing) return existing;
    const newData = new CapacitySummary();
    this.set(id, newData);
    return newData;
  };
}

/**
 * Note: this type is used when saving data in IndexedDB
 * so it must be a plain object without fancy method functions.
 */
class BudgetSummary {
  sorted_amount = 0;
  unsorted_amount = 0;
  number_of_unsorted_items = 0;
  rolled_over_amount = 0;
}

/**
 * @example
 * {
 *    "2026-01": {
 *      sorted_amount: 100,
 *      unsorted_amount: 10,
 *      number_of_unsorted_items: 2,
 *      rolled_over_amount: 50
 *    },
 *    "2026-02": {
 *      sorted_amount: 150,
 *      unsorted_amount: 9,
 *      number_of_unsorted_items: 1,
 *      rolled_over_amount: 40
 *    }
 * }
 */
export type BudgetSummaryByMonth = { [k: string]: BudgetSummary };

/**
 * Helper class to abstract budget history write & read processes.
 */
export class BudgetHistory {
  private data: BudgetSummaryByMonth = {};
  private range?: [Date, Date];

  constructor(data?: BudgetSummaryByMonth) {
    if (data) this.data = data;
  }

  private getKey = (date: Date) => getYearMonthString(date);
  private getDate = (key: string) => new LocalDate(`${key}-15`);

  getData = () => ({ ...this.data });
  getRange = () => this.range && [...this.range];

  get startDate() {
    return this.range && new ViewDate("month", this.range[0]);
  }

  get endDate() {
    return this.range && new ViewDate("month", this.range[1]);
  }

  set = (date: Date, query: Partial<BudgetSummary>) => {
    if (!this.range) this.range = [date, date];
    else if (this.range[1] < date) this.range[1] = date;
    else if (date < this.range[0]) this.range[0] = date;
    const existing = this.get(date);
    assign(existing, query);
  };

  get = (date: Date): BudgetSummary => {
    const key = this.getKey(date);
    if (!this.data[key]) this.data[key] = new BudgetSummary();
    return this.data[key];
  };

  /**
   * Add amount to the specified date's position.
   * If amount doesn't exist in the position, assume it was 0.
   */
  add = (date: Date, query: Partial<BudgetSummary>) => {
    const existing = this.get(date);
    Object.entries(query).forEach(([key, value]) => {
      existing[key as keyof BudgetSummary] += value;
    });
  };

  /**
   * Returns an array of budget history.
   * Values are 0-indexed where 0 is the month of the given `viewDate`,
   * 1 is the previous month, and so on.
   */
  toArray = (viewDate: ViewDate) => {
    const result: BudgetSummary[] = [];
    Object.entries(this.data).forEach(([key, value]) => {
      const date = this.getDate(key);
      if (!isDate(date)) return;
      const span = viewDate.getSpanFrom(date);
      if (span >= 0) result[span] = value;
    });
    return result;
  };
}

export class BudgetData {
  private data = new Map<string, BudgetHistory>();

  get size() {
    return this.data.size;
  }

  getEntries = () => Array.from(this.data.entries());

  set(budgetLikeId: string, budgetHistory: BudgetHistory): void;
  set(budgetLikeId: string, date: Date, budgetSummary: Partial<BudgetSummary>): void;
  set(
    budgetLikeId: string,
    dateOrBudgetHistory: Date | BudgetHistory,
    budgetSummary?: Partial<BudgetSummary>,
  ) {
    if (isDate(dateOrBudgetHistory) && budgetSummary) {
      const date = dateOrBudgetHistory;
      if (!this.data.has(budgetLikeId)) this.data.set(budgetLikeId, new BudgetHistory());
      const accountData = this.data.get(budgetLikeId)!;
      accountData.set(date!, budgetSummary!);
    } else if (dateOrBudgetHistory instanceof BudgetHistory) {
      const budgetHistory = dateOrBudgetHistory;
      this.data.set(budgetLikeId, budgetHistory);
    }
  }

  get(budgetLikeId: string): BudgetHistory;
  get(budgetLikeId: string, date: Date): BudgetSummary;
  get(budgetLikeId: string, date?: Date) {
    if (!this.data.has(budgetLikeId)) this.data.set(budgetLikeId, new BudgetHistory());
    const accountData = this.data.get(budgetLikeId)!;
    if (date === undefined) return accountData;
    return accountData.get(date);
  }

  add = (budgetLikeId: string, date: Date, budgetSummary: Partial<BudgetSummary>) => {
    this.get(budgetLikeId).add(date, budgetSummary);
  };

  forEach = (cb: (history: BudgetHistory, id: string) => void) => this.data.forEach(cb);
}

/**
 * Represents transaction <-> split transaction relationship.
 * The parent transaction id is the key and the children split transactions are
 * the value of the data.
 */
/**
 * Summary of a holding's value at a point in time.
 * Note: this type is used when saving data in IndexedDB
 * so it must be a plain object without fancy method functions.
 */
export class HoldingValueSummary {
  value: number = 0;
  costBasis: number | null = null;
  quantity: number = 0;
  price: number = 0;
  security_id: string = "";
  account_id: string = "";
  costBasisInferred: boolean = false;

  constructor(init?: Partial<HoldingValueSummary>) {
    if (init) assign(this, init);
  }

  get unrealizedGain(): number | null {
    if (this.costBasis === null) return null;
    return this.value - this.costBasis;
  }

  get returnPercent(): number | null {
    if (this.costBasis === null || this.costBasis === 0) return null;
    return ((this.value - this.costBasis) / this.costBasis) * 100;
  }

  get isCostBasisEstimated(): boolean {
    return this.costBasisInferred;
  }
}

/**
 * @example
 * {
 *    "2026-01": { value: 1000, costBasis: 900, ... },
 *    "2026-02": { value: 1100, costBasis: 900, ... }
 * }
 */
export type HoldingValueByMonth = { [k: string]: HoldingValueSummary };

/**
 * Helper class to abstract holding value history write & read processes.
 * Similar to BalanceHistory but stores HoldingValueSummary instead of number.
 */
export class HoldingValueHistory {
  private data: HoldingValueByMonth = {};
  private range?: [Date, Date];

  constructor(data?: HoldingValueByMonth) {
    if (data) this.data = data;
  }

  private getKey = (date: Date) => getYearMonthString(date);
  private getDate = (key: string) => new LocalDate(`${key}-15`);

  getData = (): HoldingValueByMonth => ({ ...this.data });
  getRange = (): [Date, Date] | undefined => this.range && [...this.range];

  get startDate() {
    return this.range && new ViewDate("month", this.range[0]);
  }

  get endDate() {
    return this.range && new ViewDate("month", this.range[1]);
  }

  set = (date: Date, summary: HoldingValueSummary) => {
    if (!this.range) this.range = [date, date];
    else if (this.range[1] < date) this.range[1] = date;
    else if (date < this.range[0]) this.range[0] = date;
    this.data[this.getKey(date)] = summary;
  };

  get = (date: Date): HoldingValueSummary | undefined => {
    return this.data[this.getKey(date)];
  };

  /**
   * Returns an array of holding value history.
   * Values are 0-indexed where 0 is the month of the given `viewDate`,
   * 1 is the previous month, and so on.
   */
  toArray = (viewDate: ViewDate) => {
    const result: HoldingValueSummary[] = [];
    Object.entries(this.data).forEach(([key, value]) => {
      const date = this.getDate(key);
      if (!isDate(date)) return;
      const span = viewDate.getSpanFrom(date);
      if (span >= 0) result[span] = value;
    });
    return result;
  };
}

/**
 * Holdings value data stored by `holdingId` (account_id + security_id).
 * Provides direct access, aggregation, and discovery methods.
 *
 * @example
 * const holdingsValueData = new HoldingsValueData();
 * const holdingId = "account1_security1";
 * const date = new Date("2026-01-01");
 *
 * holdingsValueData.set(holdingId, date, new HoldingValueSummary({
 *   value: 1000, costBasis: 900, quantity: 10, price: 100,
 *   security_id: "security1", account_id: "account1"
 * }));
 *
 * console.log(holdingsValueData.getHoldingValue(holdingId, date)); // 1000
 * console.log(holdingsValueData.getAccountTotalValue("account1", date)); // 1000
 */
export class HoldingsValueData {
  private data = new Map<string, HoldingValueHistory>();

  get size() {
    return this.data.size;
  }

  getEntries = () => Array.from(this.data.entries());

  // --- Direct access methods ---

  set(holdingId: string, history: HoldingValueHistory): void;
  set(holdingId: string, date: Date, summary: HoldingValueSummary): void;
  set(holdingId: string, dateOrHistory: Date | HoldingValueHistory, summary?: HoldingValueSummary) {
    if (isDate(dateOrHistory) && summary) {
      const date = dateOrHistory;
      if (!this.data.has(holdingId)) this.data.set(holdingId, new HoldingValueHistory());
      const holdingData = this.data.get(holdingId)!;
      holdingData.set(date, summary);
    } else if (dateOrHistory instanceof HoldingValueHistory) {
      this.data.set(holdingId, dateOrHistory);
    }
  }

  getHistory(holdingId: string): HoldingValueHistory {
    if (!this.data.has(holdingId)) this.data.set(holdingId, new HoldingValueHistory());
    return this.data.get(holdingId)!;
  }

  getHoldingValue = (holdingId: string, date: Date): number | undefined => {
    return this.getHistory(holdingId).get(date)?.value;
  };

  getHoldingPrice = (holdingId: string, date: Date): number | undefined => {
    return this.getHistory(holdingId).get(date)?.price;
  };

  getHoldingCostBasis = (holdingId: string, date: Date): number | null | undefined => {
    return this.getHistory(holdingId).get(date)?.costBasis;
  };

  getHoldingUnrealizedGain = (holdingId: string, date: Date): number | null | undefined => {
    return this.getHistory(holdingId).get(date)?.unrealizedGain;
  };

  // --- Aggregation methods ---

  getAccountTotalValue = (accountId: string, date: Date): number => {
    let total = 0;
    this.data.forEach((history, holdingId) => {
      const summary = history.get(date);
      if (summary && summary.account_id === accountId) {
        total += summary.value;
      }
    });
    return total;
  };

  getAccountUnrealizedGain = (accountId: string, date: Date): number | null => {
    let total: number | null = 0;
    let hasData = false;
    this.data.forEach((history, holdingId) => {
      const summary = history.get(date);
      if (summary && summary.account_id === accountId) {
        hasData = true;
        const gain = summary.unrealizedGain;
        if (gain !== null && total !== null) {
          total += gain;
        } else {
          // If any holding has null gain, mark total as partial (still sum others)
        }
      }
    });
    return hasData ? total : null;
  };

  // --- Discovery methods ---

  getHoldingsForAccount = (accountId: string): string[] => {
    const holdings: string[] = [];
    this.data.forEach((history, holdingId) => {
      // Check any entry to get the account_id
      const data = history.getData();
      const firstEntry = Object.values(data)[0];
      if (firstEntry && firstEntry.account_id === accountId) {
        holdings.push(holdingId);
      }
    });
    return holdings;
  };

  getAllHoldingIds = (): string[] => {
    return Array.from(this.data.keys());
  };

  getDateRange = (): [Date, Date] | undefined => {
    let minDate: Date | undefined;
    let maxDate: Date | undefined;
    this.data.forEach((history) => {
      const range = history.getRange();
      if (range) {
        if (!minDate || range[0] < minDate) minDate = range[0];
        if (!maxDate || range[1] > maxDate) maxDate = range[1];
      }
    });
    return minDate && maxDate ? [minDate, maxDate] : undefined;
  };

  forEach = (cb: (history: HoldingValueHistory, id: string) => void) => this.data.forEach(cb);
}

/**
 * Represents transaction <-> split transaction relationship.
 * The parent transaction id is the key and the children split transactions are
 * the value of the data.
 */
export class TransactionFamilies {
  private data = new Map<string, SplitTransactionDictionary>();

  get size() {
    return this.data.size;
  }

  getEntries = () => Array.from(this.data.entries());

  set = (transactionId: string, children: SplitTransactionDictionary) => {
    this.data.set(transactionId, children);
  };

  get = (transactionId: string): SplitTransactionDictionary | undefined => {
    return this.data.get(transactionId);
  };

  add = (transactionId: string, child: SplitTransaction) => {
    if (!this.data.has(transactionId)) {
      this.data.set(transactionId, new SplitTransactionDictionary());
    }
    this.data.get(transactionId)!.set(child.id, child);
  };

  getChildrenAmountTotal = (transactionId: string) => {
    let total = 0;
    this.get(transactionId)?.forEach(({ amount }) => {
      total += amount;
    });
    return total;
  };

  forEach = (cb: (children: SplitTransactionDictionary, id: string) => void) => {
    this.data.forEach(cb);
  };
}
