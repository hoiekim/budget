import {
  JSONBudget,
  JSONCapacity,
  isString,
  isNullableString,
  isNullableBoolean,
} from "common";
import {
  BUDGET_ID,
  USER_ID,
  ISO_CURRENCY_CODE,
  UPDATED,
  IS_DELETED,
} from "./common";
import {
  BUDGETS,
  USERS,
} from "common/constants";

import { Model, RowValueType, createTable } from "./base";
import {
  applyBudgetFamilyFields,
  budgetFamilyJSON,
  budgetFamilySchema,
  budgetFamilyTypeChecker,
} from "./budget-family";

const budgetSchema = {
  [BUDGET_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
  ...budgetFamilySchema,
  [ISO_CURRENCY_CODE]: "VARCHAR(10) DEFAULT 'USD'",
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
    ...budgetFamilyTypeChecker,
    iso_currency_code: isNullableString,
    updated: isNullableString,
    is_deleted: isNullableBoolean,
  };

  constructor(data: unknown) {
    super(data, BudgetModel.typeChecker);
  }

  toJSON(): JSONBudget {
    return {
      budget_id: this.budget_id,
      iso_currency_code: this.iso_currency_code,
      ...budgetFamilyJSON(this),
    };
  }

  static fromJSON(b: Partial<JSONBudget>, user_id: string): Partial<BudgetRow> {
    const r: Partial<BudgetRow> = { user_id };
    if (b.budget_id !== undefined) r.budget_id = b.budget_id;
    if (b.iso_currency_code !== undefined) r.iso_currency_code = b.iso_currency_code;
    applyBudgetFamilyFields(b, r);
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
