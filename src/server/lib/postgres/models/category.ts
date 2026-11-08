import {
  JSONCategory,
  JSONCapacity,
  isString,
  isNullableString,
  isNullableBoolean,
} from "common";
import {
  CATEGORY_ID,
  SECTION_ID,
  USER_ID,
  UPDATED,
  IS_DELETED,
} from "./common";
import {
  CATEGORIES,
  SECTIONS,
  USERS,
} from "common/constants";

import { Model, RowValueType, createTable } from "./base";
import {
  applyBudgetFamilyFields,
  budgetFamilyJSON,
  budgetFamilySchema,
  budgetFamilyTypeChecker,
} from "./budget-family";

const categorySchema = {
  [CATEGORY_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
  [SECTION_ID]: `UUID REFERENCES ${SECTIONS}(${SECTION_ID}) ON DELETE RESTRICT NOT NULL`,
  ...budgetFamilySchema,
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

type CategorySchema = typeof categorySchema;
type CategoryRow = { [k in keyof CategorySchema]: RowValueType };

export class CategoryModel extends Model<JSONCategory, CategorySchema> implements CategoryRow {
  declare category_id: string;
  declare user_id: string;
  declare section_id: string;
  declare name: string;
  declare roll_over: boolean;
  declare roll_over_start_date: string | null;
  declare capacities: JSONCapacity[];
  declare updated: string | null;
  declare is_deleted: boolean;

  static typeChecker = {
    category_id: isString,
    user_id: isString,
    section_id: isString,
    ...budgetFamilyTypeChecker,
    updated: isNullableString,
    is_deleted: isNullableBoolean,
  };

  constructor(data: unknown) {
    super(data, CategoryModel.typeChecker);
  }

  toJSON(): JSONCategory {
    return {
      category_id: this.category_id,
      section_id: this.section_id,
      ...budgetFamilyJSON(this),
    };
  }

  static fromJSON(c: Partial<JSONCategory>, user_id: string): Partial<CategoryRow> {
    const r: Partial<CategoryRow> = { user_id };
    if (c.category_id !== undefined) r.category_id = c.category_id;
    if (c.section_id !== undefined) r.section_id = c.section_id;
    applyBudgetFamilyFields(c, r);
    return r;
  }
}

export const categoriesTable = createTable({
  name: CATEGORIES,
  primaryKey: CATEGORY_ID,
  schema: categorySchema,
  indexes: [{ column: USER_ID }, { column: SECTION_ID }],
  ModelClass: CategoryModel,
});

export const categoryColumns = Object.keys(categoriesTable.schema);
