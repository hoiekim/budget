import {
  Capacity,
  JSONCapacity,
  ViewDate,
  assign,
  globalData,
  getDateTimeString,
  sortCapacities,
  Interval,
  MAX_FLOAT,
} from "common";

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

class BudgetSummary {
  sorted_amount = 0;
  unsorted_amount = 0;
  number_of_unsorted_items = 0;
  rolled_over_amount = 0;
}

class BudgetSummaryCache extends Map<string, BudgetSummary> {
  getOrNew = (id: string) => {
    const existing = this.get(id);
    if (existing) return existing;
    const newData = new BudgetSummary();
    this.set(id, newData);
    return newData;
  };
}

const summaryCache = new BudgetSummaryCache();

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

  get sorted_amount() {
    return summaryCache.getOrNew(this.id).sorted_amount;
  }
  set sorted_amount(n: number) {
    summaryCache.getOrNew(this.id).sorted_amount = n;
  }

  get unsorted_amount() {
    return summaryCache.getOrNew(this.id).unsorted_amount;
  }
  set unsorted_amount(n: number) {
    summaryCache.getOrNew(this.id).unsorted_amount = n;
  }

  get number_of_unsorted_items() {
    return summaryCache.getOrNew(this.id).number_of_unsorted_items;
  }
  set number_of_unsorted_items(n: number) {
    summaryCache.getOrNew(this.id).number_of_unsorted_items = n;
  }

  get rolled_over_amount() {
    return summaryCache.getOrNew(this.id).rolled_over_amount;
  }
  set rolled_over_amount(n: number) {
    summaryCache.getOrNew(this.id).rolled_over_amount = n;
  }

  name: string = "";
  capacities = [new Capacity()];
  roll_over: boolean = false;
  roll_over_start_date?: Date;

  constructor(init?: Partial<BudgetFamily | JSONBudgetFamily>) {
    assign(this, init);
    this.fromJSON();
  }

  protected fromJSON = () => {
    if (typeof this.roll_over_start_date === "string") {
      this.roll_over_start_date = new Date(this.roll_over_start_date);
    }
    this.capacities = this.capacities.map((c) => new Capacity(c));
  };

  toJSON = () => {
    const rollDate = this.roll_over_start_date;
    const roll_over_start_date = rollDate && getDateTimeString(rollDate);
    return { ...this, roll_over_start_date };
  };

  clone = (override?: Partial<BudgetFamily | JSONBudgetFamily>): this => {
    const overrode = override ? assign(this.clone(), override) : this;
    return new (this.constructor as any)(overrode);
  };

  sortCapacities = (order: "asc" | "desc" = "asc") => {
    return [...this.capacities].sort((a, b) => sortCapacities(a, b, order));
  };

  getActiveCapacity = (date: Date) => {
    const validCapacity = this.sortCapacities("desc").find((capacity) => {
      const { active_from } = capacity;
      return new Date(active_from || 0) <= date;
    });

    return validCapacity || new Capacity();
  };

  getAccumulatedCapacity = (startDate: Date, viewDate: ViewDate) => {
    const interval = viewDate.getInterval();
    let sum = 0;
    this.sortCapacities().forEach((e, i) => {
      const from = e.active_from || startDate;
      const nextCapacity = this.capacities[i + 1];
      const endDate = nextCapacity?.active_from;
      const endDateAsNumber = endDate?.getTime() || Infinity;
      const isEndDateEarlier = endDateAsNumber < viewDate.getDate().getTime();
      const endViewDate = endDate ? new ViewDate(interval, endDate) : viewDate;
      const dateHelper = isEndDateEarlier ? endViewDate : viewDate;
      const span = dateHelper.getSpanFrom(from);
      if (span > 0) sum += span * e[interval];
    });
    return sum;
  };

  isChildrenSynced = (interval: Interval) => {
    let isSynced = true;
    this.capacities.forEach((capacity) => {
      const capacityAmount = capacity[interval];
      const isInfinite = Math.abs(capacityAmount) === MAX_FLOAT;
      const isChildrenSynced = capacity.children_total === capacityAmount;
      const isBudget = this.type === "budget";
      const isGrandChildrenSynced = !isBudget || capacity.grand_children_total === capacityAmount;
      isSynced = isSynced && (isInfinite || (isChildrenSynced && isGrandChildrenSynced));
    });
    return isSynced;
  };

  getChildren = () => {
    const { id } = this;
    const { sections, categories } = globalData;
    const childSections = sections.filter((s) => s.budget_id === id);
    if (childSections.length) return childSections;
    return categories.filter((c) => c.section_id === id);
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

export interface JSONBudgetFamily {
  name: string;
  capacities: JSONCapacity[];
  roll_over: boolean;
  roll_over_start_date?: string;
}
