import { JSONChart, ChartType, isString } from "common";
import {
  CHART_ID,
  USER_ID,
  NAME,
  TYPE,
  CONFIGURATION,
  UPDATED,
  IS_DELETED,
  CHARTS,
  USERS,
} from "./common";
import {
  Schema,
  Constraints,
  IndexDefinition,
  Table,
  AssertTypeFn,
  createAssertType,
  Model,
  isNullableString,
  isNullableBoolean,
  isNullableDate,
  toDate,
} from "./base";

export class ChartModel extends Model<JSONChart> {
  chart_id: string;
  user_id: string;
  name: string;
  type: ChartType;
  configuration: string;
  updated: Date;
  is_deleted: boolean;

  constructor(data: unknown) {
    super();
    ChartModel.assertType(data);
    const row = data as Record<string, unknown>;
    this.chart_id = row.chart_id as string;
    this.user_id = row.user_id as string;
    this.name = (row.name as string) || "Unnamed";
    this.type = (row.type as ChartType) || ChartType.BALANCE;
    this.configuration = (row.configuration as string) || "";
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = (row.is_deleted as boolean) ?? false;
  }

  toJSON(): JSONChart {
    return {
      chart_id: this.chart_id,
      name: this.name,
      type: this.type,
      configuration: this.configuration,
    };
  }

  static fromJSON(chart: Partial<JSONChart>, user_id: string): Record<string, unknown> {
    const row: Record<string, unknown> = { user_id };
    if (chart.chart_id !== undefined) row.chart_id = chart.chart_id;
    if (chart.name !== undefined) row.name = chart.name;
    if (chart.type !== undefined) row.type = chart.type;
    if (chart.configuration !== undefined) {
      row.configuration = typeof chart.configuration === "string"
        ? chart.configuration
        : JSON.stringify(chart.configuration);
    }
    return row;
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("ChartModel", {
    chart_id: isString,
    user_id: isString,
    name: isNullableString,
    type: isNullableString,
    configuration: isNullableString,
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  });
}

export class ChartsTable extends Table<JSONChart, ChartModel> {
  readonly name = CHARTS;
  readonly schema: Schema<Record<string, unknown>> = {
    [CHART_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
    [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT`,
    [NAME]: "VARCHAR(255) DEFAULT 'Unnamed'",
    [TYPE]: "VARCHAR(50)",
    [CONFIGURATION]: "JSONB",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
    [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  };
  readonly constraints: Constraints = [];
  readonly indexes: IndexDefinition[] = [{ column: USER_ID }];
  readonly ModelClass = ChartModel;
}

export const chartsTable = new ChartsTable();
export const chartColumns = Object.keys(chartsTable.schema);
