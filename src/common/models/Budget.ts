import { getRandomId, assign } from "common";
import { BudgetFamily, JSONBudgetFamily } from "./BudgetFamily";

export class Budget extends BudgetFamily {
  get id() {
    return this.budget_id;
  }
  set id(_: string) {}

  budget_id: string = getRandomId();
  iso_currency_code: string = "USD";

  constructor(init?: Partial<Budget | JSONBudget>) {
    super();
    assign(this, init);
    this.fromJSON();
  }
}

export interface JSONBudget extends JSONBudgetFamily {
  budget_id: string;
  iso_currency_code: string;
}
