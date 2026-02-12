import {
  JSONSection,
  JSONCapacity,
  isString,
  isNullableString,
  isNullableBoolean,
  isNullableArray,
} from "common";
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
import { Model, RowValueType, createTable } from "./base";

const sectionSchema = {
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

type SectionSchema = typeof sectionSchema;
type SectionRow = { [k in keyof SectionSchema]: RowValueType };

export class SectionModel extends Model<JSONSection, SectionSchema> implements SectionRow {
  section_id!: string;
  user_id!: string;
  budget_id!: string;
  name!: string;
  roll_over!: boolean;
  roll_over_start_date!: string | null;
  capacities!: JSONCapacity[];
  updated!: string | null;
  is_deleted!: boolean;

  static typeChecker = {
    section_id: isString,
    user_id: isString,
    budget_id: isString,
    name: isNullableString,
    roll_over: isNullableBoolean,
    roll_over_start_date: isNullableString,
    capacities: isNullableArray,
    updated: isNullableString,
    is_deleted: isNullableBoolean,
  };

  constructor(data: unknown) {
    super(data, SectionModel.typeChecker);
  }

  toJSON(): JSONSection {
    return {
      section_id: this.section_id,
      budget_id: this.budget_id,
      name: this.name,
      roll_over: this.roll_over,
      roll_over_start_date: this.roll_over_start_date || undefined,
      capacities: this.capacities,
    };
  }

  static fromJSON(s: Partial<JSONSection>, user_id: string): Partial<SectionRow> {
    const r: Partial<SectionRow> = { user_id };
    if (s.section_id !== undefined) r.section_id = s.section_id;
    if (s.budget_id !== undefined) r.budget_id = s.budget_id;
    if (s.name !== undefined) r.name = s.name;
    if (s.roll_over !== undefined) r.roll_over = s.roll_over;
    if (s.roll_over_start_date !== undefined) r.roll_over_start_date = s.roll_over_start_date;
    if (s.capacities !== undefined) r.capacities = JSON.stringify(s.capacities);
    return r;
  }
}

export const sectionsTable = createTable({
  name: SECTIONS,
  primaryKey: SECTION_ID,
  schema: sectionSchema,
  indexes: [{ column: USER_ID }, { column: BUDGET_ID }],
  ModelClass: SectionModel,
});

export const sectionColumns = Object.keys(sectionsTable.schema);
