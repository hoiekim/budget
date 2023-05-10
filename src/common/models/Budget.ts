import { getRandomId } from "common";

export type Interval = "year" | "month" | "week" | "day";

export type Capacity = {
  [key in Interval]: number;
};

export class Budget {
  get id() {
    return this.budget_id;
  }
  set id(_: string) {}

  budget_id: string = getRandomId();
  name: string = "";
  capacities: Capacity[] = [{ year: 0, month: 0, week: 0, day: 0 }];
  iso_currency_code: string = "USD";
  roll_over: boolean = false;
  roll_over_start_date?: string;

  constructor(init?: Partial<Budget>) {
    Object.assign(this, init);
  }
}
