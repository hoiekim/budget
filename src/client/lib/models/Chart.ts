import {
  getRandomId,
  assign,
  JSONChart,
  ChartType,
  JSONBalanceChartConfiguration,
  JSONProjectionChartConfiguration,
  JSONAmountInTime,
  excludeEnumeration,
} from "common";

type ChartConfiguration = BalanceChartConfiguration | ProjectionChartConfiguration;

export class Chart {
  get id() {
    return this.chart_id;
  }

  chart_id: string = getRandomId();
  name = "Unnamed";
  type = ChartType.BALANCE;
  configuration: ChartConfiguration = new BalanceChartConfiguration();

  constructor(init?: Partial<Chart | JSONChart>) {
    assign(this, init);
    this.fromJSON();
    excludeEnumeration(this, ["fromJSON", "toJSON"]);
  }

  protected fromJSON = () => {
    if (typeof this.configuration === "string") {
      if (this.type === ChartType.BALANCE) {
        this.configuration = new BalanceChartConfiguration(JSON.parse(this.configuration));
      } else if (this.type === ChartType.PROJECTION) {
        this.configuration = new ProjectionChartConfiguration(JSON.parse(this.configuration));
      }
    } else if (this.configuration) {
      if (this.type === ChartType.BALANCE) {
        this.configuration = new BalanceChartConfiguration(this.configuration as any);
      } else if (this.type === ChartType.PROJECTION) {
        this.configuration = new ProjectionChartConfiguration(this.configuration as any);
      }
    }
  };

  toJSON = (): JSONChart => {
    const configuration = JSON.stringify(this.configuration);
    return { ...this, configuration };
  };
}

export class BalanceChartConfiguration implements JSONBalanceChartConfiguration {
  account_ids: string[] = [];
  budget_ids: string[] = [];

  constructor(init?: Partial<BalanceChartConfiguration>) {
    assign(this, init);
  }
}

export class ProjectionChartConfiguration implements JSONProjectionChartConfiguration {
  account_ids: string[] = [];
  initial_saving = new AmountInTime();
  living_cost = new AmountInTime();
  contribution = 0;
  anual_percentage_yield = 1.09;
  year_over_year_inflation = 1.038;

  constructor(init?: Partial<ProjectionChartConfiguration>) {
    assign(this, init);
    if (init?.initial_saving) this.initial_saving = new AmountInTime(init.initial_saving);
    if (init?.living_cost) this.living_cost = new AmountInTime(init.living_cost);
  }
}

export class AmountInTime implements JSONAmountInTime {
  amount = 0;
  amountAsOf = new Date();
  taxRate?: number;

  constructor(init?: Partial<AmountInTime>) {
    assign(this, init);
    if (init?.amountAsOf) this.amountAsOf = new Date(init.amountAsOf);
  }
}

export type BalanceChart = Omit<Chart, "type" | "configuration"> & {
  type: ChartType.BALANCE;
  configuration: BalanceChartConfiguration;
};

export type ProjectionChart = Omit<Chart, "type" | "configuration"> & {
  type: ChartType.PROJECTION;
  configuration: ProjectionChartConfiguration;
};
