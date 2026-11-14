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
} from "./common";
import {
  CHARTS,
  USERS,
} from "common/constants";

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
  declare chart_id: string;
  declare user_id: string;
  declare name: string;
  declare type: ChartType;
  declare configuration: string;
  declare updated: string | null;
  declare is_deleted: boolean;

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
    // Type conversion: the driver parses JSONB to object, need to stringify for our string type
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
      // The client sends configuration as a JSON string; parse it to the
      // object the JSONB column stores. A string bound for JSONB would be
      // stored as a JSON string value under Bun.sql (pg had the server
      // parse it into JSON). A malformed string throws here instead of
      // failing at the server — either way the write is refused.
      r.configuration =
        typeof c.configuration === "string" ? JSON.parse(c.configuration) : c.configuration;
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
