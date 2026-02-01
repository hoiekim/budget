import { getRandomId, assign, JSONBudget } from "common";
import { BudgetFamily } from "./BudgetFamily";

export class Budget extends BudgetFamily {
  get id() {
    return this.budget_id;
  }

  get type() {
    return "budget" as const;
  }

  budget_id: string = getRandomId();
  iso_currency_code: string = "USD";

  constructor(init?: Partial<Budget | JSONBudget>) {
    super();
    assign(this, init);
    this.fromJSON();
  }

  toJSON(): JSONBudget {
    return { ...this, ...super.toJSON() };
  }
}
