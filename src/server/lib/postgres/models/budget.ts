import {
  JSONBudget,
  JSONCapacity,
  isString,
  isNullableString,
  isNullableBoolean,
  isNullableArray,
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
import { Model, RowValueType, createTable } from "./base";

const budgetSchema = {
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

type BudgetSchema = typeof budgetSchema;
type BudgetRow = { [k in keyof BudgetSchema]: RowValueType };

export class BudgetModel extends Model<JSONBudget, BudgetSchema> implements BudgetRow {
  declare budget_id: string;
  declare user_id: string;
  declare name: string;
  declare iso_currency_code: string;
  declare roll_over: boolean;
  declare roll_over_start_date: string | null;
  declare capacities: JSONCapacity[];
  declare updated: string | null;
  declare is_deleted: boolean;

  static typeChecker = {
    budget_id: isString,
    user_id: isString,
    name: isNullableString,
    iso_currency_code: isNullableString,
    roll_over: isNullableBoolean,
    roll_over_start_date: isNullableString,
    capacities: isNullableArray,
    updated: isNullableString,
    is_deleted: isNullableBoolean,
  };

  constructor(data: unknown) {
    super(data, BudgetModel.typeChecker);
  }

  toJSON(): JSONBudget {
    return {
      budget_id: this.budget_id,
      name: this.name,
      iso_currency_code: this.iso_currency_code,
      roll_over: this.roll_over,
      roll_over_start_date: this.roll_over_start_date || undefined,
      capacities: this.capacities,
    };
  }

  static fromJSON(b: Partial<JSONBudget>, user_id: string): Partial<BudgetRow> {
    const r: Partial<BudgetRow> = { user_id };
    if (b.budget_id !== undefined) r.budget_id = b.budget_id;
    if (b.name !== undefined) r.name = b.name;
    if (b.iso_currency_code !== undefined) r.iso_currency_code = b.iso_currency_code;
    if (b.roll_over !== undefined) r.roll_over = b.roll_over;
    if (b.roll_over_start_date !== undefined) r.roll_over_start_date = b.roll_over_start_date;
    if (b.capacities !== undefined) r.capacities = JSON.stringify(b.capacities);
    return r;
  }
}

export const budgetsTable = createTable({
  name: BUDGETS,
  primaryKey: BUDGET_ID,
  schema: budgetSchema,
  indexes: [{ column: USER_ID }],
  ModelClass: BudgetModel,
});

export const budgetColumns = Object.keys(budgetsTable.schema);
