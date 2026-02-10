import { getRandomId, assign, JSONSection } from "common";
import { BudgetFamily } from "./BudgetFamily";

export class Section extends BudgetFamily {
  get id() {
    return this.section_id;
  }

  get type() {
    return "section" as const;
  }

  section_id: string = getRandomId();
  budget_id: string = "";

  constructor(init: Partial<Section | JSONSection> & { budget_id: string }) {
    super(init);
    assign(this, init);
    this.fromJSON();
  }

  toJSON(): JSONSection {
    return { ...this, ...super.toJSON() };
  }
}
