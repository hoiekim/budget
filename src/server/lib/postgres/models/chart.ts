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
import { Schema, AssertTypeFn, createAssertType, Model, createTable } from "./base";

export class ChartModel extends Model<JSONChart> {
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

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType(
    "ChartModel",
    ChartModel.typeChecker,
  );

  constructor(data: unknown) {
    super();
    ChartModel.assertType(data);
    const r = data as Record<string, unknown>;
    Object.keys(ChartModel.typeChecker).forEach((k) => {
      (this as Record<string, unknown>)[k] = r[k];
    });
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

  static toRow(c: Partial<JSONChart>, user_id: string): Record<string, unknown> {
    const r: Record<string, unknown> = { user_id };
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
  schema: {
    [CHART_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
    [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT`,
    [NAME]: "VARCHAR(255) DEFAULT 'Unnamed'",
    [TYPE]: "VARCHAR(50)",
    [CONFIGURATION]: "JSONB",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
    [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  } as Schema<Record<string, unknown>>,
  indexes: [{ column: USER_ID }],
  ModelClass: ChartModel,
});

export const chartColumns = Object.keys(chartsTable.schema);
