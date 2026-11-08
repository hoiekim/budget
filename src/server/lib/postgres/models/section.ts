import {
  JSONSection,
  JSONCapacity,
  isString,
  isNullableString,
  isNullableBoolean,
} from "common";
import {
  SECTION_ID,
  BUDGET_ID,
  USER_ID,
  UPDATED,
  IS_DELETED,
} from "./common";
import {
  BUDGETS,
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

const sectionSchema = {
  [SECTION_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
  [BUDGET_ID]: `UUID REFERENCES ${BUDGETS}(${BUDGET_ID}) ON DELETE RESTRICT NOT NULL`,
  ...budgetFamilySchema,
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

type SectionSchema = typeof sectionSchema;
type SectionRow = { [k in keyof SectionSchema]: RowValueType };

export class SectionModel extends Model<JSONSection, SectionSchema> implements SectionRow {
  declare section_id: string;
  declare user_id: string;
  declare budget_id: string;
  declare name: string;
  declare roll_over: boolean;
  declare roll_over_start_date: string | null;
  declare capacities: JSONCapacity[];
  declare updated: string | null;
  declare is_deleted: boolean;

  static typeChecker = {
    section_id: isString,
    user_id: isString,
    budget_id: isString,
    ...budgetFamilyTypeChecker,
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
      ...budgetFamilyJSON(this),
    };
  }

  static fromJSON(s: Partial<JSONSection>, user_id: string): Partial<SectionRow> {
    const r: Partial<SectionRow> = { user_id };
    if (s.section_id !== undefined) r.section_id = s.section_id;
    if (s.budget_id !== undefined) r.budget_id = s.budget_id;
    applyBudgetFamilyFields(s, r);
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
