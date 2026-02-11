import {
  JSONCategory,
  JSONCapacity,
  isString,
  isNullableString,
  isNullableBoolean,
  isNullableDate,
} from "common";
import {
  CATEGORY_ID, SECTION_ID, USER_ID, NAME, ROLL_OVER,
  ROLL_OVER_START_DATE, CAPACITIES, UPDATED, IS_DELETED, CATEGORIES, SECTIONS, USERS,
} from "./common";
import { Schema, AssertTypeFn, createAssertType, Model, createTable } from "./base";
import { toDate, parseJSONB, isNullableJSONB } from "../util";

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
    const r = data as Record<string, unknown>;
    this.category_id = r.category_id as string;
    this.user_id = r.user_id as string;
    this.section_id = r.section_id as string;
    this.name = (r.name as string) || "Unnamed";
    this.roll_over = (r.roll_over as boolean) ?? false;
    this.roll_over_start_date = r.roll_over_start_date ? toDate(r.roll_over_start_date) : undefined;
    this.capacities = parseJSONB<JSONCapacity[]>(r.capacities, []);
    this.updated = r.updated ? toDate(r.updated) : new Date();
    this.is_deleted = (r.is_deleted as boolean) ?? false;
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

  static toRow(c: Partial<JSONCategory>, user_id: string): Record<string, unknown> {
    const r: Record<string, unknown> = { user_id };
    if (c.category_id !== undefined) r.category_id = c.category_id;
    if (c.section_id !== undefined) r.section_id = c.section_id;
    if (c.name !== undefined) r.name = c.name;
    if (c.roll_over !== undefined) r.roll_over = c.roll_over;
    if (c.roll_over_start_date !== undefined) r.roll_over_start_date = c.roll_over_start_date;
    if (c.capacities !== undefined) r.capacities = JSON.stringify(c.capacities);
    return r;
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("CategoryModel", {
    category_id: isString,
    user_id: isString,
    section_id: isString,
    name: isNullableString,
    roll_over: isNullableBoolean,
    roll_over_start_date: isNullableDate,
    capacities: isNullableJSONB,
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  });
}

export const categoriesTable = createTable({
  name: CATEGORIES,
  primaryKey: CATEGORY_ID,
  schema: {
    [CATEGORY_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
    [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
    [SECTION_ID]: `UUID REFERENCES ${SECTIONS}(${SECTION_ID}) ON DELETE RESTRICT NOT NULL`,
    [NAME]: "VARCHAR(255) DEFAULT 'Unnamed'",
    [ROLL_OVER]: "BOOLEAN DEFAULT FALSE",
    [ROLL_OVER_START_DATE]: "DATE",
    [CAPACITIES]: "JSONB",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
    [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  } as Schema<Record<string, unknown>>,
  indexes: [{ column: USER_ID }, { column: SECTION_ID }],
  ModelClass: CategoryModel,
});

export const categoryColumns = Object.keys(categoriesTable.schema);
