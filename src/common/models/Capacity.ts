import { MAX_FLOAT, assign, getDateTimeString } from "common";

export type Interval = "year" | "month" | "week" | "day";
export const intervals: Interval[] = ["year", "month", "week", "day"];

export class Capacity {
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
}

export interface JSONCapacity {
  year: number;
  month: number;
  week: number;
  day: number;
  active_from?: string;
}
