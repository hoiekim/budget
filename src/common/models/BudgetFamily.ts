export type Interval = "year" | "month";

export interface JSONCapacity {
  capacity_id: string;
  month: number;
  active_from?: string;
}

export interface JSONBudgetFamily {
  name: string;
  capacities: JSONCapacity[];
  roll_over: boolean;
  roll_over_start_date?: Date;
}

export interface JSONBudget extends JSONBudgetFamily {
  budget_id: string;
  iso_currency_code: string;
}

export interface JSONSection extends JSONBudgetFamily {
  section_id: string;
  budget_id: string;
}

export interface JSONCategory extends JSONBudgetFamily {
  category_id: string;
  section_id: string;
}
