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
  IndexDefinition,
  Table,
  AssertTypeFn,
  createAssertType,
  Model,
  isNullableString,
  isNullableBoolean,
  isNullableDate,
  toDate,
} from "./base";

export class CategoryModel extends Model<JSONCategory> {
  category_id: string;
  user_id: string;
  section_id: string;
  name: string;
  roll_over: boolean;
  roll_over_start_date: Date | undefined;
  capacities: JSONCapacity[];
  updated: Date;
  is_deleted: boolean;

  constructor(data: unknown) {
    super();
    CategoryModel.assertType(data);
    const row = data as Record<string, unknown>;
    this.category_id = row.category_id as string;
    this.user_id = row.user_id as string;
    this.section_id = row.section_id as string;
    this.name = (row.name as string) || "Unnamed";
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

  static fromJSON(category: Partial<JSONCategory>, user_id: string): Record<string, unknown> {
    const row: Record<string, unknown> = { user_id };
    if (category.category_id !== undefined) row.category_id = category.category_id;
    if (category.section_id !== undefined) row.section_id = category.section_id;
    if (category.name !== undefined) row.name = category.name;
    if (category.roll_over !== undefined) row.roll_over = category.roll_over;
    if (category.roll_over_start_date !== undefined) row.roll_over_start_date = category.roll_over_start_date;
    if (category.capacities !== undefined) row.capacities = JSON.stringify(category.capacities);
    return row;
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("CategoryModel", {
    category_id: isString,
    user_id: isString,
    section_id: isString,
    name: isNullableString,
    roll_over: isNullableBoolean,
    roll_over_start_date: isNullableDate,
    capacities: (v): v is unknown => isUndefined(v) || isNull(v) || isString(v) || isArray(v),
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  });
}

export class CategoriesTable extends Table<JSONCategory, CategoryModel> {
  readonly name = CATEGORIES;
  readonly schema: Schema<Record<string, unknown>> = {
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
  readonly constraints: Constraints = [];
  readonly indexes: IndexDefinition[] = [{ column: USER_ID }, { column: SECTION_ID }];
  readonly ModelClass = CategoryModel;
}

export const categoriesTable = new CategoriesTable();
export const categoryColumns = Object.keys(categoriesTable.schema);
