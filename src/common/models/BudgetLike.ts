import { Capacity, JSONCapacity, assign, getDateTimeString } from "common";

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

  getActiveCapacity = (date: Date) => {
    const validCapacity = this.capacities
      .sort((a, b) => {
        const validFromA = new Date(a.active_from || 0);
        const validFromB = new Date(b.active_from || 0);
        return validFromB.getTime() - validFromA.getTime();
      })
      .find((capacity) => {
        const { active_from } = capacity;
        return new Date(active_from || 0) < date;
      });

    return validCapacity || new Capacity();
  };
}

export interface JSONBudgetLike {
  name: string;
  capacities: JSONCapacity[];
  roll_over: boolean;
  roll_over_start_date?: string;
}
