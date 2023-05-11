import { ViewDate, Capacity, assign } from "common";

export class BudgetLike {
  name: string = "";
  capacities: Capacity[] = [{ year: 0, month: 0, week: 0, day: 0 }];
  roll_over: boolean = false;
  roll_over_start_date?: string;
  sorted_amount = 0;
  unsorted_amount = 0;
  rolled_over_amount = 0;

  constructor(init?: Partial<BudgetLike>) {
    assign(this, init);
    Object.defineProperties(this, {
      sorted_amount: { enumerable: false, writable: true },
      unsorted_amount: { enumerable: false, writable: true },
      rolled_over_amount: { enumerable: false, writable: true },
    });
  }

  getValidCapacity = (viewDate: ViewDate) => {
    const date = viewDate.getDate();
    const interval = viewDate.getInterval();

    const validCapacity = this.capacities
      .sort((a, b) => {
        const validFromA = new Date(a.valid_from || 0);
        const validFromB = new Date(b.valid_from || 0);
        return validFromB.getTime() - validFromA.getTime();
      })
      .find((capacity) => {
        const { valid_from } = capacity;
        return new Date(valid_from || 0) < date;
      });

    return validCapacity ? validCapacity[interval] : 0;
  };

  getValidCapacity4test = () => {
    return this.capacities;
  };
}
