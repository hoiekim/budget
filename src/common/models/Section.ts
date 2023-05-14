import { getRandomId, assign } from "common";
import { BudgetLike, JSONBudgetLike } from "./BudgetLike";

export class Section extends BudgetLike {
  get id() {
    return this.section_id;
  }
  set id(_: string) {}

  section_id: string = getRandomId();
  budget_id: string = "";

  constructor(init: Partial<Section | JSONSection> & { budget_id: string }) {
    super();
    assign(this, init);
    this.fromJSON();
  }
}

export interface JSONSection extends JSONBudgetLike {
  section_id: string;
  budget_id: string;
}
