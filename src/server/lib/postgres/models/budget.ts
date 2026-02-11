import {
  JSONBudget,
  JSONCapacity,
  isString,
  isArray,
  isNull,
  isUndefined,
  isNullableString,
  isNullableBoolean,
  isNullableDate,
} from "common";
import {
  BUDGET_ID,
  USER_ID,
  NAME,
  ISO_CURRENCY_CODE,
  ROLL_OVER,
  ROLL_OVER_START_DATE,
  CAPACITIES,
  UPDATED,
  IS_DELETED,
  BUDGETS,
  USERS,
} from "./common";
import { Schema, Constraints, IndexDefinition, Table, AssertTypeFn, createAssertType, Model } from "./base";
import { toDate } from "../util";

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
    const row = data as Record<string, unknown>;
    this.budget_id = row.budget_id as string;
    this.user_id = row.user_id as string;
    this.name = (row.name as string) || "Unnamed";
    this.iso_currency_code = (row.iso_currency_code as string) || "USD";
    this.roll_over = (row.roll_over as boolean) ?? false;
    this.roll_over_start_date = row.roll_over_start_date
      ? toDate(row.roll_over_start_date)
      : undefined;
    this.capacities = this.parseCapacities(row.capacities);
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = (row.is_deleted as boolean) ?? false;
  }

  private parseCapacities(value: unknown): JSONCapacity[] {
    if (!value) return [];
    if (typeof value === "string") {
      try { return JSON.parse(value); } catch { return []; }
    }
    return value as JSONCapacity[];
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

  static fromJSON(budget: Partial<JSONBudget>, user_id: string): Record<string, unknown> {
    const row: Record<string, unknown> = { user_id };
    if (budget.budget_id !== undefined) row.budget_id = budget.budget_id;
    if (budget.name !== undefined) row.name = budget.name;
    if (budget.iso_currency_code !== undefined) row.iso_currency_code = budget.iso_currency_code;
    if (budget.roll_over !== undefined) row.roll_over = budget.roll_over;
    if (budget.roll_over_start_date !== undefined) row.roll_over_start_date = budget.roll_over_start_date;
    if (budget.capacities !== undefined) row.capacities = JSON.stringify(budget.capacities);
    return row;
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("BudgetModel", {
    budget_id: isString,
    user_id: isString,
    name: isNullableString,
    iso_currency_code: isNullableString,
    roll_over: isNullableBoolean,
    roll_over_start_date: isNullableDate,
    capacities: (v): v is unknown => isUndefined(v) || isNull(v) || isString(v) || isArray(v),
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  });
}

export class BudgetsTable extends Table<JSONBudget, BudgetModel> {
  readonly name = BUDGETS;
  readonly schema: Schema<Record<string, unknown>> = {
    [BUDGET_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
    [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
    [NAME]: "VARCHAR(255) DEFAULT 'Unnamed'",
    [ISO_CURRENCY_CODE]: "VARCHAR(10) DEFAULT 'USD'",
    [ROLL_OVER]: "BOOLEAN DEFAULT FALSE",
    [ROLL_OVER_START_DATE]: "DATE",
    [CAPACITIES]: "JSONB",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
    [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  };
  readonly constraints: Constraints = [];
  readonly indexes: IndexDefinition[] = [{ column: USER_ID }];
  readonly ModelClass = BudgetModel;
}

export const budgetsTable = new BudgetsTable();
export const budgetColumns = Object.keys(budgetsTable.schema);
