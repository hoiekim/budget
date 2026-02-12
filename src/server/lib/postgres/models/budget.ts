import {
  JSONBudget,
  JSONCapacity,
  isString,
  isNullableString,
  isNullableBoolean,
  isNullableDate,
  isNullableArray,
} from "common";
import {
  BUDGET_ID, USER_ID, NAME, ISO_CURRENCY_CODE, ROLL_OVER,
  ROLL_OVER_START_DATE, CAPACITIES, UPDATED, IS_DELETED, BUDGETS, USERS,
} from "./common";
import { Schema, AssertTypeFn, createAssertType, Model, createTable } from "./base";

export class BudgetModel extends Model<JSONBudget> {
  budget_id: string;
  user_id: string;
  name: string;
  iso_currency_code: string;
  roll_over: boolean;
  roll_over_start_date: Date | undefined;
  capacities: JSONCapacity[];
  updated: Date;
  is_deleted: boolean;

  constructor(data: unknown) {
    super();
    BudgetModel.assertType(data);
    const r = data as Record<string, unknown>;
    this.budget_id = r.budget_id as string;
    this.user_id = r.user_id as string;
    this.name = (r.name as string) || "Unnamed";
    this.iso_currency_code = (r.iso_currency_code as string) || "USD";
    this.roll_over = (r.roll_over as boolean) ?? false;
    this.roll_over_start_date = (r.roll_over_start_date as Date) ?? undefined;
    this.capacities = (r.capacities as JSONCapacity[]) ?? [];
    this.updated = (r.updated as Date) ?? new Date();
    this.is_deleted = (r.is_deleted as boolean) ?? false;
  }

  toJSON(): JSONBudget {
    return {
      budget_id: this.budget_id,
      name: this.name,
      iso_currency_code: this.iso_currency_code,
      roll_over: this.roll_over,
      roll_over_start_date: this.roll_over_start_date,
      capacities: this.capacities,
    };
  }

  static toRow(b: Partial<JSONBudget>, user_id: string): Record<string, unknown> {
    const r: Record<string, unknown> = { user_id };
    if (b.budget_id !== undefined) r.budget_id = b.budget_id;
    if (b.name !== undefined) r.name = b.name;
    if (b.iso_currency_code !== undefined) r.iso_currency_code = b.iso_currency_code;
    if (b.roll_over !== undefined) r.roll_over = b.roll_over;
    if (b.roll_over_start_date !== undefined) r.roll_over_start_date = b.roll_over_start_date;
    if (b.capacities !== undefined) r.capacities = JSON.stringify(b.capacities);
    return r;
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("BudgetModel", {
    budget_id: isString,
    user_id: isString,
    name: isNullableString,
    iso_currency_code: isNullableString,
    roll_over: isNullableBoolean,
    roll_over_start_date: isNullableDate,
    capacities: isNullableArray,
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  });
}

export const budgetsTable = createTable({
  name: BUDGETS,
  primaryKey: BUDGET_ID,
  schema: {
    [BUDGET_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
    [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
    [NAME]: "VARCHAR(255) DEFAULT 'Unnamed'",
    [ISO_CURRENCY_CODE]: "VARCHAR(10) DEFAULT 'USD'",
    [ROLL_OVER]: "BOOLEAN DEFAULT FALSE",
    [ROLL_OVER_START_DATE]: "DATE",
    [CAPACITIES]: "JSONB",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
    [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  } as Schema<Record<string, unknown>>,
  indexes: [{ column: USER_ID }],
  ModelClass: BudgetModel,
});

export const budgetColumns = Object.keys(budgetsTable.schema);
