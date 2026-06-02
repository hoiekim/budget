export type Interval = "year" | "month";

export interface JSONCapacity {
  capacity_id: string;
  /**
   * Stored capacity amount in dollars-per-month. Authoritative ONLY when
   * `is_synced !== true`. When `is_synced === true`, this column is treated
   * as advisory cache — readers must derive the amount via
   * `Capacity.getActiveAmount(interval, children)` which sums the same
   * period's amounts from the parent's children. Persisting a value here
   * for synced rows is allowed (last-known-good cache) but never read.
   */
  month: number;
  active_from?: string;
  /**
   * When true, this capacity is "synced with children" — the displayed
   * amount is the sum of children's amounts for the same period, computed
   * on read. Eliminates the data-corruption class where a frontend math
   * bug could persist a stale sum into `month`. Only meaningful for
   * `budget`/`section` rows (categories are leaves; their capacities are
   * always authoritative). Defaults to false; pre-existing rows behave
   * exactly as before until explicitly opted in via the config page.
   */
  is_synced?: boolean;
}

export interface JSONBudgetFamily {
  name: string;
  capacities: JSONCapacity[];
  roll_over: boolean;
  roll_over_start_date?: string;
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
