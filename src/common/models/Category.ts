import { getRandomId, assign } from "common";
import { BudgetLike } from "./BudgetLike";

export class Category extends BudgetLike {
  get id() {
    return this.category_id;
  }
  set id(_: string) {}

  category_id: string = getRandomId();
  section_id: string = "";

  constructor(init: Partial<Category> & { section_id: string }) {
    super();
    assign(this, init);
  }
}
