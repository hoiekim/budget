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
  // transactions whose own label has no budget_id and whose owning
  // account also has no fallback budget_id — it can appear in the list
  // to opt-in to including unsorted ("Others") transactions.
  budget_ids: string[];
}

// Sentinel `budget_id` for a transaction with no budget label AND whose
// owning account has no fallback budget label. Rendered as "Others" in
// the Sankey column and exposed as the italic "Others" toggle in the
// chart-accounts UI. Must stay in sync with `getSankeyData`'s
// `t.label.budget_id || account.label.budget_id || UNSORTED_BUDGET_ID`
// fallback in `src/client/components/FlowChartRow/lib.ts`.
export const UNSORTED_BUDGET_ID = "Unknown";

export interface JSONProjectionChartConfiguration {
  account_ids: string[];
  auto_saving_config?: boolean;
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
