import {
  Capacity,
  JSONCapacity,
  ViewDate,
  assign,
  getDateTimeString,
  sortCapacities,
} from "common";

export class BudgetLike {
  name: string = "";
  capacities = [new Capacity()];
  roll_over: boolean = false;
  roll_over_start_date?: Date;
  sorted_amount = 0;
  unsorted_amount = 0;
  rolled_over_amount = 0;

  constructor(init?: Partial<BudgetLike | JSONBudgetLike>) {
    assign(this, init);
    this.fromJSON();
  }

  protected fromJSON = () => {
    if (typeof this.roll_over_start_date === "string") {
      this.roll_over_start_date = new Date(this.roll_over_start_date);
    }
    this.capacities = this.capacities.map((c) => new Capacity(c));
  };

  toJSON = () => {
    const rollDate = this.roll_over_start_date;
    const roll_over_start_date = rollDate && getDateTimeString(rollDate);
    return {
      ...this,
      roll_over_start_date,
      sorted_amount: undefined,
      unsorted_amount: undefined,
      rolled_over_amount: undefined,
    };
  };

  sortCapacities = (order: "asc" | "desc" = "asc") => {
    return this.capacities.sort((a, b) => sortCapacities(a, b, order));
  };

  getActiveCapacity = (date: Date) => {
    const validCapacity = this.sortCapacities("desc").find((capacity) => {
      const { active_from } = capacity;
      return new Date(active_from || 0) < date;
    });

    return validCapacity || new Capacity();
  };

  getAccumulatedCapacity = (viewDate: ViewDate, startDate: Date) => {
    const interval = viewDate.getInterval();
    let sum = 0;
    this.sortCapacities().forEach((e, i) => {
      const from = e.active_from || startDate;
      const nextCapacity = this.capacities[i + 1];
      const endDate = nextCapacity?.active_from;
      const endDateAsNumber = endDate?.getTime() || Infinity;
      const isEndDateEarlier = endDateAsNumber < viewDate.getDate().getTime();
      const endViewDate = endDate ? new ViewDate(interval, endDate) : viewDate;
      const dateHelper = isEndDateEarlier ? endViewDate : viewDate;
      const span = dateHelper.getSpanFrom(from);
      if (span > 0) sum += span * e[interval];
    });
    return sum;
  };
}

export interface JSONBudgetLike {
  name: string;
  capacities: JSONCapacity[];
  roll_over: boolean;
  roll_over_start_date?: string;
}
