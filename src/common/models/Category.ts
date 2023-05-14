import { getRandomId, assign } from "common";
import { BudgetLike, JSONBudgetLike } from "./BudgetLike";

export class Category extends BudgetLike {
  get id() {
    return this.category_id;
  }
  set id(_: string) {}

  category_id: string = getRandomId();
  section_id: string = "";

  constructor(init: Partial<Category | JSONCategory> & { section_id: string }) {
    super();
    assign(this, init);
    this.fromJSON();
  }
}

export interface JSONCategory extends JSONBudgetLike {
  category_id: string;
  section_id: string;
}
