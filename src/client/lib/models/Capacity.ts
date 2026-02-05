import {
  JSONCapacity,
  MAX_FLOAT,
  assign,
  excludeEnumeration,
  getDateTimeString,
} from "common";

export type Interval = "year" | "month";
export const intervals: Interval[] = ["year", "month"];

// Generate UUID with fallback for environments without crypto.randomUUID
const generateUUID = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: generate UUID v4 manually
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

export class Capacity {
  get id() {
    return this.capacity_id;
  }

  capacity_id!: string;

  get year() {
    return this.month * 12;
  }

  month = 0;

  active_from?: Date;

  constructor(init?: Partial<Capacity | JSONCapacity>) {
    assign(this, init);
    // Only generate UUID if not provided
    if (!this.capacity_id) {
      this.capacity_id = generateUUID();
    }
    if (typeof this.active_from === "string") {
      this.active_from = new Date(this.active_from);
    }
    excludeEnumeration(this, ["toJSON", "fromInputs", "toInputs"]);
  }

  toJSON = (): JSONCapacity => {
    const active_from = this.active_from && getDateTimeString(this.active_from);
    return { ...this, active_from };
  };

  static fromInputs = (
    capacityInput: Capacity,
    isIncomeInput: boolean,
    isInfiniteInput: boolean,
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
