/**
 * Chart model and schema definition.
 */

import { JSONChart, ChartType } from "common";
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
  PropertyChecker,
  AssertTypeFn,
  createAssertType,
  isString,
  isNullableString,
  isNullableBoolean,
  isNullableDate,
  toDate,
} from "./base";

// =============================================
// Chart Row Interface
// =============================================

export interface ChartRow {
  chart_id: string;
  user_id: string;
  name: string | null;
  type: string | null;
  configuration: string | null;
  updated: Date | null;
  is_deleted: boolean | null;
}

// =============================================
// Chart Model Class
// =============================================

export class ChartModel {
  chart_id: string;
  user_id: string;
  name: string;
  type: ChartType;
  configuration: string;
  updated: Date;
  is_deleted: boolean;

  constructor(row: ChartRow) {
    ChartModel.assertType(row);
    this.chart_id = row.chart_id;
    this.user_id = row.user_id;
    this.name = row.name || "Unnamed";
    this.type = (row.type as ChartType) || ChartType.BALANCE;
    this.configuration = row.configuration || "";
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = row.is_deleted ?? false;
  }

  toJSON(): JSONChart {
    return {
      chart_id: this.chart_id,
      name: this.name,
      type: this.type,
      configuration: this.configuration,
    };
  }

  static fromJSON(
    chart: Partial<JSONChart>,
    user_id: string
  ): Partial<ChartRow> {
    const row: Partial<ChartRow> = { user_id };

    if (chart.chart_id !== undefined) row.chart_id = chart.chart_id;
    if (chart.name !== undefined) row.name = chart.name;
    if (chart.type !== undefined) row.type = chart.type;
    if (chart.configuration !== undefined) {
      row.configuration =
        typeof chart.configuration === "string"
          ? chart.configuration
          : JSON.stringify(chart.configuration);
    }

    return row;
  }

  static assertType: AssertTypeFn<ChartRow> = createAssertType<ChartRow>("ChartModel", {
    chart_id: isString,
    user_id: isString,
    name: isNullableString,
    type: isNullableString,
    configuration: isNullableString,
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  } as PropertyChecker<ChartRow>);
}

// =============================================
// Chart Schema
// =============================================

export const chartSchema: Schema<ChartRow> = {
  [CHART_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT`,
  [NAME]: "VARCHAR(255) DEFAULT 'Unnamed'",
  [TYPE]: "VARCHAR(50)",
  [CONFIGURATION]: "JSONB",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

export const chartConstraints: Constraints = [];

export const chartColumns = Object.keys(chartSchema);

export const chartIndexes = [{ table: CHARTS, column: USER_ID }];
