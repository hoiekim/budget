import { getRandomId, assign } from "common";
import { BudgetLike } from "./BudgetLike";

export class Budget extends BudgetLike {
  get id() {
    return this.budget_id;
  }
  set id(_: string) {}

  budget_id: string = getRandomId();
  iso_currency_code: string = "USD";

  constructor(init?: Partial<Budget>) {
    super();
    assign(this, init);
  }
}
