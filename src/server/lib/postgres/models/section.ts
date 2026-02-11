import { JSONSection, JSONCapacity, isString, isArray, isNull, isUndefined } from "common";
import {
  SECTION_ID,
  BUDGET_ID,
  USER_ID,
  NAME,
  ROLL_OVER,
  ROLL_OVER_START_DATE,
  CAPACITIES,
  UPDATED,
  IS_DELETED,
  SECTIONS,
  BUDGETS,
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

export interface SectionRow {
  section_id: string;
  user_id: string;
  budget_id: string;
  name: string | null | undefined;
  roll_over: boolean | null | undefined;
  roll_over_start_date: Date | null | undefined;
  capacities: JSONCapacity[] | string | null | undefined;
  updated: Date | null | undefined;
  is_deleted: boolean | null | undefined;
}

export class SectionModel extends Model<SectionRow, JSONSection> {
  section_id: string;
  user_id: string;
  budget_id: string;
  name: string;
  roll_over: boolean;
  roll_over_start_date: Date | undefined;
  capacities: JSONCapacity[];
  updated: Date;
  is_deleted: boolean;

  constructor(row: SectionRow) {
    super();
    SectionModel.assertType(row);
    this.section_id = row.section_id;
    this.user_id = row.user_id;
    this.budget_id = row.budget_id;
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

  toJSON(): JSONSection {
    return {
      section_id: this.section_id,
      budget_id: this.budget_id,
      name: this.name,
      roll_over: this.roll_over,
      roll_over_start_date: this.roll_over_start_date,
      capacities: this.capacities,
    };
  }

  static fromJSON(section: Partial<JSONSection>, user_id: string): Partial<SectionRow> {
    const row: Partial<SectionRow> = { user_id };
    if (section.section_id !== undefined) row.section_id = section.section_id;
    if (section.budget_id !== undefined) row.budget_id = section.budget_id;
    if (section.name !== undefined) row.name = section.name;
    if (section.roll_over !== undefined) row.roll_over = section.roll_over;
    if (section.roll_over_start_date !== undefined) row.roll_over_start_date = section.roll_over_start_date;
    if (section.capacities !== undefined) row.capacities = JSON.stringify(section.capacities);
    return row;
  }

  static assertType: AssertTypeFn<SectionRow> = createAssertType<SectionRow>("SectionModel", {
    section_id: isString,
    user_id: isString,
    budget_id: isString,
    name: isNullableString,
    roll_over: isNullableBoolean,
    roll_over_start_date: isNullableDate,
    capacities: (v): v is JSONCapacity[] | string | null | undefined =>
      isUndefined(v) || isNull(v) || isString(v) || isArray(v),
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  });
}

export const sectionSchema: Schema<SectionRow> = {
  [SECTION_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
  [BUDGET_ID]: `UUID REFERENCES ${BUDGETS}(${BUDGET_ID}) ON DELETE RESTRICT NOT NULL`,
  [NAME]: "VARCHAR(255) DEFAULT 'Unnamed'",
  [ROLL_OVER]: "BOOLEAN DEFAULT FALSE",
  [ROLL_OVER_START_DATE]: "DATE",
  [CAPACITIES]: "JSONB",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

export const sectionConstraints: Constraints = [];
export const sectionColumns = Object.keys(sectionSchema);
export const sectionIndexes = [{ column: USER_ID }, { column: BUDGET_ID }];

export const sectionTable: TableDefinition = {
  name: SECTIONS,
  schema: sectionSchema as Schema<Record<string, unknown>>,
  constraints: sectionConstraints,
  indexes: sectionIndexes,
};
