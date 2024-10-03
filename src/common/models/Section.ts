import { getRandomId, assign } from "common";
import { BudgetFamily, JSONBudgetFamily } from "./BudgetFamily";

export class Section extends BudgetFamily {
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

export interface JSONSection extends JSONBudgetFamily {
  section_id: string;
  budget_id: string;
}
