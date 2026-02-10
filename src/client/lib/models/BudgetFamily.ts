import { assign, excludeEnumeration, getDateTimeString, JSONBudgetFamily, LocalDate } from "common";
import { Capacity, sortCapacities } from "./Capacity";
import { globalData } from "./Data";
import { CapacityData } from "client";

export type BudgetFamilyType = "budget" | "section" | "category";
export type BudgetFamilyDictionaryKey = "budgets" | "sections" | "categories";

const getParentType = (type: BudgetFamilyType) => {
  switch (type) {
    case "budget":
      return undefined;
    case "section":
      return "budget";
    case "category":
      return "section";
  }
};

export class BudgetFamily {
  get id(): string {
    throw new Error("Not implemented: id");
  }

  get type(): BudgetFamilyType {
    throw new Error("Not implemented: type");
  }

  get dictionaryKey(): BudgetFamilyDictionaryKey {
    switch (this.type) {
      case "budget":
        return "budgets";
      case "section":
        return "sections";
      case "category":
        return "categories";
      default:
        throw new Error(`Unknown budget type: ${this.type}`);
    }
  }

  name: string = "";
  capacities: Capacity[] = [];
  roll_over: boolean = false;
  roll_over_start_date?: Date;

  constructor(init?: Partial<BudgetFamily | JSONBudgetFamily>) {
    assign(this, init);
    this.fromJSON();
    if (!this.capacities.length) this.capacities = [new Capacity()];
    excludeEnumeration(this, [
      "fromJSON",
      "toJSON",
      "clone",
      "sortCapacities",
      "getActiveCapacity",
      "isChildrenSynced",
      "getChildren",
      "getParent",
    ]);
  }

  protected fromJSON = () => {
    if (typeof this.roll_over_start_date === "string") {
      this.roll_over_start_date = new LocalDate(this.roll_over_start_date);
    }
    this.capacities = this.capacities.map((c) => new Capacity(c));
  };

  toJSON(): JSONBudgetFamily {
    const rollDate = this.roll_over_start_date;
    const roll_over_start_date = rollDate && getDateTimeString(rollDate);
    const capacities = this.capacities.map((c) => c.toJSON());
    return { ...this, roll_over_start_date, capacities };
  }

  clone = (override?: Partial<BudgetFamily | JSONBudgetFamily>): this => {
    const overrode = override ? assign(this.clone(), override) : this;
    return new (this.constructor as any)(overrode);
  };

  sortCapacities = (order: "asc" | "desc" = "asc") => {
    return [...this.capacities].sort((a, b) => sortCapacities(a, b, order));
  };

  getActiveCapacity = (date: Date) => {
    const sorted = this.sortCapacities("desc");
    const validCapacity = sorted.find((capacity) => {
      const { active_from } = capacity;
      return new LocalDate(active_from || 0) <= date;
    });

    return validCapacity || sorted[sorted.length - 1];
  };

  isChildrenSynced = (capacityData: CapacityData) => {
    if (this.type === "category") return true;
    let isSynced = true;
    this.capacities.forEach((capacity) => {
      const capacityAmount = capacity.month;
      const isChildrenSynced = capacityData.get(capacity.id).children_total === capacityAmount;
      const isBudget = this.type === "budget";
      const isGrandChildrenSynced =
        !isBudget || capacityData.get(capacity.id).grand_children_total === capacityAmount;
      isSynced = isSynced && isChildrenSynced && isGrandChildrenSynced;
    });
    return isSynced;
  };

  getChildren = () => {
    const { id, type } = this;
    const { sections, categories } = globalData;
    if (type === "budget") return sections.filter((s) => s.budget_id === id);
    else if (type === "section") return categories.filter((c) => c.section_id === id);
    else return [];
  };

  getParent = () => {
    const { type } = this;
    const parentType = getParentType(type);
    const parentIdKey = `${parentType}_id`;
    // Assuming each budget member has correct parent id property
    const parentId = (this as any)[parentIdKey] as string;
    if (!parentId || typeof parentId !== "string") return;
    const { budgets, sections } = globalData;
    const parentBudget = budgets.get(parentId);
    if (parentBudget) return parentBudget;
    return sections.get(parentId);
  };
}
