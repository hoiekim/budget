import {
  JSONChart,
  ChartType,
  isString,
  isNullableString,
  isNullableBoolean,
  isNullableObject,
} from "common";
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
import { Model, RowValueType, createTable } from "./base";

const chartSchema = {
  [CHART_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT`,
  [NAME]: "VARCHAR(255) DEFAULT 'Unnamed'",
  [TYPE]: "VARCHAR(50)",
  [CONFIGURATION]: "JSONB",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

type ChartSchema = typeof chartSchema;
type ChartRow = { [k in keyof ChartSchema]: RowValueType };

export class ChartModel extends Model<JSONChart, ChartSchema> implements ChartRow {
  chart_id!: string;
  user_id!: string;
  name!: string;
  type!: ChartType;
  configuration!: string;
  updated!: string | null;
  is_deleted!: boolean;

  static typeChecker = {
    chart_id: isString,
    user_id: isString,
    name: isNullableString,
    type: isNullableString,
    configuration: isNullableObject,
    updated: isNullableString,
    is_deleted: isNullableBoolean,
  };

  constructor(data: unknown) {
    super(data, ChartModel.typeChecker);
    // Type conversion: pg parses JSONB to object, need to stringify for our string type
    this.configuration =
      typeof this.configuration === "object"
        ? JSON.stringify(this.configuration)
        : (this.configuration as string);
  }

  toJSON(): JSONChart {
    return {
      chart_id: this.chart_id,
      name: this.name,
      type: this.type,
      configuration: this.configuration,
    };
  }

  static fromJSON(c: Partial<JSONChart>, user_id: string): Partial<ChartRow> {
    const r: Partial<ChartRow> = { user_id };
    if (c.chart_id !== undefined) r.chart_id = c.chart_id;
    if (c.name !== undefined) r.name = c.name;
    if (c.type !== undefined) r.type = c.type;
    if (c.configuration !== undefined) {
      r.configuration =
        typeof c.configuration === "string" ? c.configuration : JSON.stringify(c.configuration);
    }
    return r;
  }
}

export const chartsTable = createTable({
  name: CHARTS,
  primaryKey: CHART_ID,
  schema: chartSchema,
  indexes: [{ column: USER_ID }],
  ModelClass: ChartModel,
});

export const chartColumns = Object.keys(chartsTable.schema);
