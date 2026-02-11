import { JSONCategory, JSONCapacity, isString, isArray, isNull, isUndefined } from "common";
import {
  CATEGORY_ID,
  SECTION_ID,
  USER_ID,
  NAME,
  ROLL_OVER,
  ROLL_OVER_START_DATE,
  CAPACITIES,
  UPDATED,
  IS_DELETED,
  CATEGORIES,
  SECTIONS,
  USERS,
} from "./common";
import {
  Schema,
  Constraints,
  TableDefinition,
  AssertTypeFn,
  createAssertType,
  Model,
  isNullableString,
  isNullableBoolean,
  isNullableDate,
  toDate,
} from "./base";

export interface CategoryRow {
  category_id: string;
  user_id: string;
  section_id: string;
  name: string | null | undefined;
  roll_over: boolean | null | undefined;
  roll_over_start_date: Date | null | undefined;
  capacities: JSONCapacity[] | string | null | undefined;
  updated: Date | null | undefined;
  is_deleted: boolean | null | undefined;
}

export class CategoryModel extends Model<CategoryRow, JSONCategory> {
  category_id: string;
  user_id: string;
  section_id: string;
  name: string;
  roll_over: boolean;
  roll_over_start_date: Date | undefined;
  capacities: JSONCapacity[];
  updated: Date;
  is_deleted: boolean;

  constructor(row: CategoryRow) {
    super();
    CategoryModel.assertType(row);
    this.category_id = row.category_id;
    this.user_id = row.user_id;
    this.section_id = row.section_id;
    this.name = row.name || "Unnamed";
    this.roll_over = row.roll_over ?? false;
    this.roll_over_start_date = row.roll_over_start_date
      ? toDate(row.roll_over_start_date)
      : undefined;
    this.capacities = this.parseCapacities(row.capacities);
    this.updated = row.updated ? toDate(row.updated) : new Date();
    this.is_deleted = row.is_deleted ?? false;
  }

  private parseCapacities(value: JSONCapacity[] | string | null | undefined): JSONCapacity[] {
    if (!value) return [];
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return [];
      }
    }
    return value;
  }

  toJSON(): JSONCategory {
    return {
      category_id: this.category_id,
      section_id: this.section_id,
      name: this.name,
      roll_over: this.roll_over,
      roll_over_start_date: this.roll_over_start_date,
      capacities: this.capacities,
    };
  }

  static fromJSON(category: Partial<JSONCategory>, user_id: string): Partial<CategoryRow> {
    const row: Partial<CategoryRow> = { user_id };
    if (category.category_id !== undefined) row.category_id = category.category_id;
    if (category.section_id !== undefined) row.section_id = category.section_id;
    if (category.name !== undefined) row.name = category.name;
    if (category.roll_over !== undefined) row.roll_over = category.roll_over;
    if (category.roll_over_start_date !== undefined) row.roll_over_start_date = category.roll_over_start_date;
    if (category.capacities !== undefined) row.capacities = JSON.stringify(category.capacities);
    return row;
  }

  static assertType: AssertTypeFn<CategoryRow> = createAssertType<CategoryRow>("CategoryModel", {
    category_id: isString,
    user_id: isString,
    section_id: isString,
    name: isNullableString,
    roll_over: isNullableBoolean,
    roll_over_start_date: isNullableDate,
    capacities: (v): v is JSONCapacity[] | string | null | undefined =>
      isUndefined(v) || isNull(v) || isString(v) || isArray(v),
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  });
}

export const categorySchema: Schema<CategoryRow> = {
  [CATEGORY_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
  [SECTION_ID]: `UUID REFERENCES ${SECTIONS}(${SECTION_ID}) ON DELETE RESTRICT NOT NULL`,
  [NAME]: "VARCHAR(255) DEFAULT 'Unnamed'",
  [ROLL_OVER]: "BOOLEAN DEFAULT FALSE",
  [ROLL_OVER_START_DATE]: "DATE",
  [CAPACITIES]: "JSONB",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

export const categoryConstraints: Constraints = [];
export const categoryColumns = Object.keys(categorySchema);
export const categoryIndexes = [{ column: USER_ID }, { column: SECTION_ID }];

export const categoryTable: TableDefinition = {
  name: CATEGORIES,
  schema: categorySchema as Schema<Record<string, unknown>>,
  constraints: categoryConstraints,
  indexes: categoryIndexes,
};
