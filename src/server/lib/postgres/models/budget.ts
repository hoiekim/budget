/**
 * Budget, Section, and Category models and schema definitions.
 */

import {
  JSONBudget,
  JSONSection,
  JSONCategory,
  JSONCapacity,
  isString,
  isArray,
  isNull,
  isUndefined,
} from "common";
import {
  BUDGET_ID,
  SECTION_ID,
  CATEGORY_ID,
  USER_ID,
  NAME,
  ISO_CURRENCY_CODE,
  ROLL_OVER,
  ROLL_OVER_START_DATE,
  CAPACITIES,
  UPDATED,
  IS_DELETED,
  BUDGETS,
  SECTIONS,
  CATEGORIES,
  USERS,
} from "./common";
import {
  Schema,
  Constraints,
  Table,
  PropertyChecker,
  AssertTypeFn,
  createAssertType,
  Model,
  isNullableString,
  isNullableBoolean,
  isNullableDate,
  toDate,
} from "./base";

// Budget Interfaces

export interface BudgetRow {
  budget_id: string;
  user_id: string;
  name: string | null | undefined;
  iso_currency_code: string | null | undefined;
  roll_over: boolean | null | undefined;
  roll_over_start_date: Date | null | undefined;
  capacities: JSONCapacity[] | string | null | undefined;
  updated: Date | null | undefined;
  is_deleted: boolean | null | undefined;
}

// Budget Model Class

export class BudgetModel extends Model<BudgetRow, JSONBudget> {
  budget_id: string;
  user_id: string;
  name: string;
  iso_currency_code: string;
  roll_over: boolean;
  roll_over_start_date: Date | undefined;
  capacities: JSONCapacity[];
  updated: Date;
  is_deleted: boolean;

  constructor(row: BudgetRow) {
    super();
    BudgetModel.assertType(row);
    this.budget_id = row.budget_id;
    this.user_id = row.user_id;
    this.name = row.name || "Unnamed";
    this.iso_currency_code = row.iso_currency_code || "USD";
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

  toJSON(): JSONBudget {
    return {
      budget_id: this.budget_id,
      name: this.name,
      iso_currency_code: this.iso_currency_code,
      roll_over: this.roll_over,
      roll_over_start_date: this.roll_over_start_date,
      capacities: this.capacities,
    };
  }

  static fromJSON(
    budget: Partial<JSONBudget>,
    user_id: string
  ): Partial<BudgetRow> {
    const row: Partial<BudgetRow> = { user_id };

    if (budget.budget_id !== undefined) row.budget_id = budget.budget_id;
    if (budget.name !== undefined) row.name = budget.name;
    if (budget.iso_currency_code !== undefined) row.iso_currency_code = budget.iso_currency_code;
    if (budget.roll_over !== undefined) row.roll_over = budget.roll_over;
    if (budget.roll_over_start_date !== undefined)
      row.roll_over_start_date = budget.roll_over_start_date;
    if (budget.capacities !== undefined)
      row.capacities = JSON.stringify(budget.capacities);

    return row;
  }

  static assertType: AssertTypeFn<BudgetRow> = createAssertType<BudgetRow>("BudgetModel", {
    budget_id: isString,
    user_id: isString,
    name: isNullableString,
    iso_currency_code: isNullableString,
    roll_over: isNullableBoolean,
    roll_over_start_date: isNullableDate,
    capacities: (v): v is JSONCapacity[] | string | null | undefined =>
      isUndefined(v) || isNull(v) || isString(v) || isArray(v),
    updated: isNullableDate,
    is_deleted: isNullableBoolean,
  });
}

// Budget Schema

export const budgetSchema: Schema<BudgetRow> = {
  [BUDGET_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [USER_ID]: `UUID REFERENCES ${USERS}(${USER_ID}) ON DELETE RESTRICT NOT NULL`,
  [NAME]: "VARCHAR(255) DEFAULT 'Unnamed'",
  [ISO_CURRENCY_CODE]: "VARCHAR(10) DEFAULT 'USD'",
  [ROLL_OVER]: "BOOLEAN DEFAULT FALSE",
  [ROLL_OVER_START_DATE]: "DATE",
  [CAPACITIES]: "JSONB",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
  [IS_DELETED]: "BOOLEAN DEFAULT FALSE",
};

export const budgetConstraints: Constraints = [];

export const budgetColumns = Object.keys(budgetSchema);

export const budgetIndexes = [{ table: BUDGETS, column: USER_ID }];

// Section Interfaces

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

// Section Model Class

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

  static fromJSON(
    section: Partial<JSONSection>,
    user_id: string
  ): Partial<SectionRow> {
    const row: Partial<SectionRow> = { user_id };

    if (section.section_id !== undefined) row.section_id = section.section_id;
    if (section.budget_id !== undefined) row.budget_id = section.budget_id;
    if (section.name !== undefined) row.name = section.name;
    if (section.roll_over !== undefined) row.roll_over = section.roll_over;
    if (section.roll_over_start_date !== undefined)
      row.roll_over_start_date = section.roll_over_start_date;
    if (section.capacities !== undefined)
      row.capacities = JSON.stringify(section.capacities);

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

// Section Schema

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

export const sectionIndexes = [
  { table: SECTIONS, column: USER_ID },
  { table: SECTIONS, column: BUDGET_ID },
];

// Category Interfaces

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

// Category Model Class

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

  static fromJSON(
    category: Partial<JSONCategory>,
    user_id: string
  ): Partial<CategoryRow> {
    const row: Partial<CategoryRow> = { user_id };

    if (category.category_id !== undefined) row.category_id = category.category_id;
    if (category.section_id !== undefined) row.section_id = category.section_id;
    if (category.name !== undefined) row.name = category.name;
    if (category.roll_over !== undefined) row.roll_over = category.roll_over;
    if (category.roll_over_start_date !== undefined)
      row.roll_over_start_date = category.roll_over_start_date;
    if (category.capacities !== undefined)
      row.capacities = JSON.stringify(category.capacities);

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

// Category Schema

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

export const categoryIndexes = [
  { table: CATEGORIES, column: USER_ID },
  { table: CATEGORIES, column: SECTION_ID },
];

export const budgetTable: Table = {
  name: BUDGETS,
  schema: budgetSchema as Schema<Record<string, unknown>>,
  constraints: budgetConstraints,
  indexes: budgetIndexes,
};

export const sectionTable: Table = {
  name: SECTIONS,
  schema: sectionSchema as Schema<Record<string, unknown>>,
  constraints: sectionConstraints,
  indexes: sectionIndexes,
};

export const categoryTable: Table = {
  name: CATEGORIES,
  schema: categorySchema as Schema<Record<string, unknown>>,
  constraints: categoryConstraints,
  indexes: categoryIndexes,
};
