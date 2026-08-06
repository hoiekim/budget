import {
  getRandomId,
  assign,
  JSONChart,
  ChartType,
  JSONBalanceChartConfiguration,
  JSONProjectionChartConfiguration,
  JSONAmountInTime,
  excludeEnumeration,
  JSONFlowChartConfiguration,
  LocalDate,
} from "common";

type ChartConfiguration =
  | BalanceChartConfiguration
  | ProjectionChartConfiguration
  | FlowChartConfiguration;

export class Chart {
  static readonly apiPath = "/api/chart";

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
      } else if (this.type === ChartType.FLOW) {
        this.configuration = new FlowChartConfiguration(JSON.parse(this.configuration));
      }
    } else if (this.configuration) {
      if (this.type === ChartType.BALANCE) {
        this.configuration = new BalanceChartConfiguration(
          this.configuration as Partial<BalanceChartConfiguration>,
        );
      } else if (this.type === ChartType.PROJECTION) {
        this.configuration = new ProjectionChartConfiguration(
          this.configuration as Partial<ProjectionChartConfiguration>,
        );
      } else if (this.type === ChartType.FLOW) {
        this.configuration = new FlowChartConfiguration(
          this.configuration as Partial<FlowChartConfiguration>,
        );
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
  auto_saving_config = false;
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

export class FlowChartConfiguration implements JSONFlowChartConfiguration {
  account_ids: string[] = [];
  budget_ids: string[] = [];

  constructor(init?: Partial<FlowChartConfiguration>) {
    assign(this, init);
  }
}

export class AmountInTime implements JSONAmountInTime {
  amount = 0;
  amountAsOf = new Date();
  taxRate?: number;

  constructor(init?: Partial<AmountInTime | JSONAmountInTime>) {
    assign(this, init);
    // Two upstream paths produce a not-a-valid-Date for `amountAsOf`
    // that reaches downstream `date.getFullYear()` calls and crashes
    // the render:
    //  - Mid-typing in a `type="date"` field: `new LocalDate("")` /
    //    `new LocalDate("2024-01-")` — Invalid Date (a Date object
    //    whose `.getTime()` returns NaN). Passed straight through the
    //    local React state.
    //  - Round-trip via server: `Date.prototype.toJSON` on an Invalid
    //    Date returns `null`, so a saved config comes back with
    //    `amountAsOf === null`. `assign` above copies null verbatim
    //    and the old guard `if (init?.amountAsOf)` skipped the
    //    re-wrap because null is falsy.
    //
    // Force a VALID Date instance in every case: try to construct one
    // from init (Date, string, number all handled by LocalDate → Date),
    // then fall back to `new Date()` if the result is invalid or the
    // input was falsy.
    const candidate = init?.amountAsOf ? new LocalDate(init.amountAsOf) : new Date();
    this.amountAsOf = isNaN(candidate.getTime()) ? new Date() : candidate;
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

export type FlowChart = Omit<Chart, "type" | "configuration"> & {
  type: ChartType.FLOW;
  configuration: FlowChartConfiguration;
};
