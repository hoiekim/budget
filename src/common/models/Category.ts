import { getRandomId, assign } from "common";
import { BudgetFamily, JSONBudgetFamily } from "./BudgetFamily";

export class Category extends BudgetFamily {
  get id() {
    return this.category_id;
  }

  get type() {
    return "category" as const;
  }

  category_id: string = getRandomId();
  section_id: string = "";

  constructor(init: Partial<Category | JSONCategory> & { section_id: string }) {
    super();
    assign(this, init);
    this.fromJSON();
  }
}

export interface JSONCategory extends JSONBudgetFamily {
  category_id: string;
  section_id: string;
}
