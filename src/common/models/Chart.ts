export enum ChartType {
  BALANCE = "balance_chart",
  PROJECTION = "projection_chart",
  FLOW = "flow_chart",
}

export interface JSONChart {
  chart_id: string;
  name: string;
  type: ChartType;
  configuration: string;
}

export interface JSONBalanceChartConfiguration {
  account_ids: string[];
  budget_ids: string[];
}

export interface JSONFlowChartConfiguration {
  account_ids: string[];
  // Empty list = include all budgets (backward-compatible default for
  // pre-existing FlowCharts). Non-empty = whitelist: only transactions
  // whose effective budget_id is in the list contribute to the Sankey.
  // The `UNSORTED_BUDGET_ID` sentinel below is the value for
  // transactions with no category, no budget_id on their own label and
  // no fallback budget_id on their owning account — it can appear in the
  // list to opt-in to including unsorted ("Others") transactions.
  budget_ids: string[];
}

// Sentinel `budget_id` for a transaction with no category, no budget
// label AND whose owning account has no fallback budget label. Rendered
// as "Others" in the Sankey column and exposed as the italic "Others"
// toggle in the chart-accounts UI. Must stay in sync with `getSankeyData`'s
// `categorySection?.budget_id || t.label.budget_id ||
// account.label.budget_id || UNSORTED_BUDGET_ID` fallback in
// `src/client/components/FlowChartRow/lib.ts`.
export const UNSORTED_BUDGET_ID = "Unknown";

export interface JSONProjectionChartConfiguration {
  account_ids: string[];
  auto_saving_config?: boolean;
  /**
   * When true the goal fields are inferred instead of read from this config:
   * living cost from the budgets in `budget_ids`, inflation from the stored
   * BLS CPI average, and tax rate from that living cost and the state the
   * user's past-year transactions point to. The manual values stay stored and
   * are used again when the flag is turned off, or as the fallback for a field
   * that has nothing to infer from yet.
   */
  auto_goal_config?: boolean;
  /** Budgets whose monthly amounts add up to the inferred living cost. */
  budget_ids?: string[];
  initial_saving: JSONAmountInTime;
  living_cost: JSONAmountInTime;
  contribution: number;
  anual_percentage_yield: number;
  year_over_year_inflation: number;
}

export interface JSONAmountInTime {
  amount: number;
  amountAsOf: Date;
  taxRate?: number;
}
