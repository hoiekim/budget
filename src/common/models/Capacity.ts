import { MAX_FLOAT, assign, getDateTimeString, getRandomId } from "common";

export type Interval = "year" | "month" | "week" | "day";
export const intervals: Interval[] = ["year", "month", "week", "day"];

class CapacitySummary {
  children_total = 0;
  grand_children_total = 0;
}

class CapacitySummaryCache extends Map<string, CapacitySummary> {
  getOrNew = (id: string) => {
    const existing = this.get(id);
    if (existing) return existing;
    const newData = new CapacitySummary();
    this.set(id, newData);
    return newData;
  };
}

const summaryCache = new CapacitySummaryCache();

export class Capacity {
  get id() {
    return this.capacity_id;
  }

  capacity_id = getRandomId();

  get children_total() {
    return summaryCache.getOrNew(this.id).children_total;
  }
  set children_total(n: number) {
    summaryCache.getOrNew(this.id).children_total = n;
  }

  get grand_children_total() {
    return summaryCache.getOrNew(this.id).grand_children_total;
  }
  set grand_children_total(n: number) {
    summaryCache.getOrNew(this.id).grand_children_total = n;
  }

  year = 0;
  month = 0;
  week = 0;
  day = 0;

  active_from?: Date;

  constructor(init?: Partial<Capacity>) {
    assign(this, init);
    if (typeof this.active_from === "string") {
      this.active_from = new Date(this.active_from);
    }
  }

  toJSON = () => {
    const active_from = this.active_from && getDateTimeString(this.active_from);
    return { ...this, active_from };
  };

  static fromInputs = (
    capacityInput: Capacity,
    isIncomeInput: boolean,
    isInfiniteInput: boolean
  ) => {
    const capacity = new Capacity(capacityInput);
    for (const interval of intervals) {
      const sign = isIncomeInput ? -1 : 1;
      const value = isInfiniteInput ? MAX_FLOAT : Math.abs(capacityInput[interval]);
      capacity[interval] = sign * value;
    }
    return capacity;
  };

  toInputs = () => {
    const capacityInput = new Capacity(this);
    let isInfiniteInput = false;
    let isIncomeInput = false;
    for (const interval of intervals) {
      const capacityValue = capacityInput[interval];
      isInfiniteInput = isInfiniteInput || Math.abs(capacityValue) === MAX_FLOAT;
      isIncomeInput = isIncomeInput || capacityValue < 0;
      capacityInput[interval] = isInfiniteInput ? 0 : Math.abs(capacityValue);
    }
    return { capacityInput, isIncomeInput, isInfiniteInput };
  };

  get isInfinite() {
    const { day, week, month, year } = this;
    return day === MAX_FLOAT || week === MAX_FLOAT || month === MAX_FLOAT || year === MAX_FLOAT;
  }

  get isIncome() {
    const { day, week, month, year } = this;
    return Math.max(day, week, month, year) < 0;
  }
}

export interface JSONCapacity {
  year: number;
  month: number;
  week: number;
  day: number;
  active_from?: string;
}

const sortCapacities = (a: Capacity, b: Capacity, order: "asc" | "desc" = "asc") => {
  const sign = order === "asc" ? 1 : -1;
  const activeFromA = a.active_from;
  const activeFromB = b.active_from;
  const factorA = activeFromA ? activeFromA.getTime() : -Infinity;
  const factorB = activeFromB ? activeFromB.getTime() : -Infinity;
  return sign * (factorA - factorB);
};

sortCapacities.asc = (a: Capacity, b: Capacity) => sortCapacities(a, b, "asc");
sortCapacities.desc = (a: Capacity, b: Capacity) => sortCapacities(a, b, "desc");

export { sortCapacities };
