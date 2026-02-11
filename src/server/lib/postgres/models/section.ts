import {
  JSONSection,
  JSONCapacity,
  isString,
  isNullableString,
  isNullableBoolean,
  isNullableDate,
} from "common";
import {
  SECTION_ID, BUDGET_ID, USER_ID, NAME, ROLL_OVER,
  ROLL_OVER_START_DATE, CAPACITIES, UPDATED, IS_DELETED, SECTIONS, BUDGETS, USERS,
} from "./common";
import { Schema, AssertTypeFn, createAssertType, Model, createTable } from "./base";
import { toDate, parseJSONB, isNullableJSONB } from "../util";

export class SectionModel extends Model<JSONSection> {
  section_id: string;
  user_id: string;
  budget_id: string;
  name: string;
  roll_over: boolean;
  roll_over_start_date: Date | undefined;
  capacities: JSONCapacity[];
  updated: Date;
  is_deleted: boolean;

  constructor(data: unknown) {
    super();
    SectionModel.assertType(data);
    const r = data as Record<string, unknown>;
    this.section_id = r.section_id as string;
    this.user_id = r.user_id as string;
    this.budget_id = r.budget_id as string;
    this.name = (r.name as string) || "Unnamed";
    this.roll_over = (r.roll_over as boolean) ?? false;
    this.roll_over_start_date = r.roll_over_start_date ? toDate(r.roll_over_start_date) : undefined;
    this.capacities = parseJSONB<JSONCapacity[]>(r.capacities, []);
    this.updated = r.updated ? toDate(r.updated) : new Date();
    this.is_deleted = (r.is_deleted as boolean) ?? false;
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

  static toRow(s: Partial<JSONSection>, user_id: string): Record<string, unknown> {
    const r: Record<string, unknown> = { user_id };
    if (s.section_id !== undefined) r.section_id = s.section_id;
    if (s.budget_id !== undefined) r.budget_id = s.budget_id;
    if (s.name !== undefined) r.name = s.name;
    if (s.roll_over !== undefined) r.roll_over = s.roll_over;
    if (s.roll_over_start_date !== undefined) r.roll_over_start_date = s.roll_over_start_date;
    if (s.capacities !== undefined) r.capacities = JSON.stringify(s.capacities);
    return r;
  }

  static assertType: AssertTypeFn<Record<string, unknown>> = createAssertType("SectionModel", {
    section_id: isString,
    user_id: isString,
    budget_id: isString,
    name: isNullableString,
    roll_over: isNullableBoolean,
    roll_over_start_date: isNullableDate,
    capacities: isNullableJSONB,
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  });
}

export const sectionsTable = createTable({
  name: SECTIONS,
  primaryKey: SECTION_ID,
  schema: {
    [SECTION_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
    [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
    [BUDGET_ID]: `UUID REFERENCES ${BUDGETS}(${BUDGET_ID}) ON DELETE RESTRICT NOT NULL`,
    [NAME]: "VARCHAR(255) DEFAULT 'Unnamed'",
    [ROLL_OVER]: "BOOLEAN DEFAULT FALSE",
    [ROLL_OVER_START_DATE]: "DATE",
    [CAPACITIES]: "JSONB",
    [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
    [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
  } as Schema<Record<string, unknown>>,
  indexes: [{ column: USER_ID }, { column: BUDGET_ID }],
  ModelClass: SectionModel,
});

export const sectionColumns = Object.keys(sectionsTable.schema);
