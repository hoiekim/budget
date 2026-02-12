import {
  JSONCategory,
  JSONCapacity,
  isString,
  isNullableString,
  isNullableBoolean,
  isNullableArray,
} from "common";
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
import { Model, RowValueType, createTable } from "./base";

const categorySchema = {
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

type CategorySchema = typeof categorySchema;
type CategoryRow = { [k in keyof CategorySchema]: RowValueType };

export class CategoryModel extends Model<JSONCategory, CategorySchema> implements CategoryRow {
  category_id!: string;
  user_id!: string;
  section_id!: string;
  name!: string;
  roll_over!: boolean;
  roll_over_start_date!: string | null;
  capacities!: JSONCapacity[];
  updated!: string | null;
  is_deleted!: boolean;

  static typeChecker = {
    category_id: isString,
    user_id: isString,
    section_id: isString,
    name: isNullableString,
    roll_over: isNullableBoolean,
    roll_over_start_date: isNullableString,
    capacities: isNullableArray,
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
      name: this.name,
      roll_over: this.roll_over,
      roll_over_start_date: this.roll_over_start_date || undefined,
      capacities: this.capacities,
    };
  }

  static fromJSON(c: Partial<JSONCategory>, user_id: string): Partial<CategoryRow> {
    const r: Partial<CategoryRow> = { user_id };
    if (c.category_id !== undefined) r.category_id = c.category_id;
    if (c.section_id !== undefined) r.section_id = c.section_id;
    if (c.name !== undefined) r.name = c.name;
    if (c.roll_over !== undefined) r.roll_over = c.roll_over;
    if (c.roll_over_start_date !== undefined) r.roll_over_start_date = c.roll_over_start_date;
    if (c.capacities !== undefined) r.capacities = JSON.stringify(c.capacities);
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
