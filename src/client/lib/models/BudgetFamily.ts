import { assign, excludeEnumeration, getDateTimeString, JSONBudgetFamily, LocalDate } from "common";
import { Capacity, sortCapacities, type Interval } from "./Capacity";
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
      "getActiveAmount",
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
    if (!this.capacities.length) this.capacities = [new Capacity()];
  };

  toJSON(): JSONBudgetFamily {
    const rollDate = this.roll_over_start_date;
    const roll_over_start_date = rollDate && getDateTimeString(rollDate);
    const capacities = this.capacities.map((c) => c.toJSON());
    return { ...this, roll_over_start_date, capacities };
  }

  clone = (override?: Partial<BudgetFamily | JSONBudgetFamily>): this => {
    const overrode = override ? assign(this.clone(), override) : this;
    const Constructor = this.constructor as new (init?: Partial<BudgetFamily | JSONBudgetFamily>) => this;
    return new Constructor(overrode);
  };

  sortCapacities = (order: "asc" | "desc" = "asc") => {
    return [...this.capacities].sort((a, b) => sortCapacities(a, b, order));
  };

  getActiveCapacity = (date: Date) => {
    if (!this.capacities.length) return new Capacity();
    const sorted = this.sortCapacities("desc");
    const validCapacity = sorted.find((capacity) => {
      const { active_from } = capacity;
      return new LocalDate(active_from || 0) <= date;
    });

    return validCapacity || sorted[sorted.length - 1] || new Capacity();
  };

  /**
   * Children-aware shortcut for the common pattern
   *   `entity.getActiveCapacity(date).getActiveAmount(date, interval, entity.getChildren())`.
   *
   * Use this everywhere a UI or calc reads "the capacity's amount" — it
   * resolves synced capacities by summing children at the **caller's
   * view date** (not the parent capacity's active_from), and falls
   * through to the stored `month` for non-synced rows.
   */
  getActiveAmount = (date: Date, interval: Interval): number => {
    const capacity = this.getActiveCapacity(date);
    return capacity.getActiveAmount(date, interval, this.getChildren());
  };

  isChildrenSynced = (capacityData: CapacityData) => {
    if (this.type === "category") return true;
    let isSynced = true;
    this.capacities.forEach((capacity) => {
      // Explicit flag is authoritative — if the user opted into "sync with
      // children" via the config page, this row IS synced regardless of
      // whether the stored `month` cache happens to match the live
      // children sum. Falls through to the legacy "stored amount equals
      // computed children total" check for pre-flag rows.
      if (capacity.is_synced) return;
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
    const parentId = (this as unknown as Record<string, string>)[parentIdKey];
    if (!parentId || typeof parentId !== "string") return;
    const { budgets, sections } = globalData;
    const parentBudget = budgets.get(parentId);
    if (parentBudget) return parentBudget;
    return sections.get(parentId);
  };
}
