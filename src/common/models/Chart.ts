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
  budget_ids: string[];
}

export interface JSONProjectionChartConfiguration {
  account_ids: string[];
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
