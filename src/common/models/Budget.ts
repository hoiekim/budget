import { getRandomId, assign } from "common";
import { BudgetLike, JSONBudgetLike } from "./BudgetLike";

export class Budget extends BudgetLike {
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

export interface JSONBudget extends JSONBudgetLike {
  budget_id: string;
  iso_currency_code: string;
}
