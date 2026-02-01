export enum ChartType {
  BALANCE = "balance_chart",
  PROJECTION = "projection_chart",
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
