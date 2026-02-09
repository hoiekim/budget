import { getRandomId, assign, JSONCategory } from "common";
import { BudgetFamily } from "./BudgetFamily";

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
    super(init);
    assign(this, init);
    this.fromJSON();
  }

  toJSON(): JSONCategory {
    return { ...this, ...super.toJSON() };
  }
}
