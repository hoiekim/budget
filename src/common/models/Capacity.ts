import { MAX_FLOAT, assign, getDateTimeString, getRandomId } from "common";

export type Interval = "year" | "month";
export const intervals: Interval[] = ["year", "month"];

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

  get year() {
    return this.month * 12;
  }

  month = 0;

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
    const sign = isIncomeInput ? -1 : 1;
    const value = isInfiniteInput ? MAX_FLOAT : Math.abs(capacityInput.month);
    capacity.month = sign * value;
    return capacity;
  };

  toInputs = () => {
    const capacityInput = new Capacity(this);
    const capacityValue = capacityInput.month;
    const isInfiniteInput = Math.abs(capacityValue) === MAX_FLOAT;
    const isIncomeInput = capacityValue < 0;
    capacityInput.month = isInfiniteInput ? 0 : Math.abs(capacityValue);
    return { capacityInput, isIncomeInput, isInfiniteInput };
  };

  get isInfinite() {
    return Math.abs(this.month) === MAX_FLOAT;
  }

  get isIncome() {
    return this.month < 0;
  }
}

export interface JSONCapacity {
  month: number;
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
