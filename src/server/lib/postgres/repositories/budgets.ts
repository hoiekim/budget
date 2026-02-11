/**
 * Budget repository - CRUD operations for budgets, sections, and categories.
 */

import { JSONBudget, JSONSection, JSONCategory } from "common";
import { QueryResult } from "pg";
import { pool } from "../client";
import { buildSelectWithFilters, selectWithFilters } from "../database";
import {
  MaskedUser,
  BudgetModel,
  BudgetRow,
  SectionModel,
  SectionRow,
  CategoryModel,
  CategoryRow,
  BUDGETS,
  SECTIONS,
  CATEGORIES,
  BUDGET_ID,
  SECTION_ID,
  CATEGORY_ID,
  USER_ID,
} from "../models";

// =============================================
// Query Helpers
// =============================================

const rowToBudget = (row: BudgetRow): JSONBudget => new BudgetModel(row).toJSON();
const rowToSection = (row: SectionRow): JSONSection => new SectionModel(row).toJSON();
const rowToCategory = (row: CategoryRow): JSONCategory => new CategoryModel(row).toJSON();

// =============================================
// Budget Repository Functions
// =============================================

/**
 * Gets all budgets for a user.
 */
export const getBudgets = async (user: MaskedUser): Promise<JSONBudget[]> => {
  const rows = await selectWithFilters<BudgetRow>(pool, BUDGETS, "*", {
    user_id: user.user_id,
  });
  return rows.map(rowToBudget);
};

/**
 * Gets a single budget by ID.
 */
export const getBudget = async (
  user: MaskedUser,
  budget_id: string
): Promise<JSONBudget | null> => {
  const rows = await selectWithFilters<BudgetRow>(pool, BUDGETS, "*", {
    user_id: user.user_id,
    primaryKey: { column: BUDGET_ID, value: budget_id },
  });
  return rows.length > 0 ? rowToBudget(rows[0]) : null;
};

/**
 * Searches budgets with optional filters.
 */
export const searchBudgets = async (
  user: MaskedUser,
  options: { budget_id?: string } = {}
): Promise<JSONBudget[]> => {
  const { sql, values } = buildSelectWithFilters(BUDGETS, "*", {
    user_id: user.user_id,
    filters: { [BUDGET_ID]: options.budget_id },
  });

  const result = await pool.query<BudgetRow>(sql, values);
  return result.rows.map(rowToBudget);
};

/**
 * Creates a new budget.
 */
export const createBudget = async (
  user: MaskedUser,
  data: Partial<JSONBudget>
): Promise<JSONBudget | null> => {
  try {
    const result = await pool.query<BudgetRow>(
      `INSERT INTO ${BUDGETS} (${USER_ID}, name, iso_currency_code, roll_over, roll_over_start_date, capacities, updated)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        user.user_id,
        data.name || "New Budget",
        data.iso_currency_code || "USD",
        data.roll_over || false,
        data.roll_over_start_date,
        JSON.stringify(data.capacities || []),
      ]
    );
    return result.rows.length > 0 ? rowToBudget(result.rows[0]) : null;
  } catch (error) {
    console.error("Failed to create budget:", error);
    return null;
  }
};

/**
 * Updates a budget.
 */
export const updateBudget = async (
  user: MaskedUser,
  budget_id: string,
  data: Partial<JSONBudget>
): Promise<boolean> => {
  const updates: string[] = ["updated = CURRENT_TIMESTAMP"];
  const values: (string | boolean | Date | undefined)[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(data.name);
  }
  if (data.iso_currency_code !== undefined) {
    updates.push(`iso_currency_code = $${paramIndex++}`);
    values.push(data.iso_currency_code);
  }
  if (data.roll_over !== undefined) {
    updates.push(`roll_over = $${paramIndex++}`);
    values.push(data.roll_over);
  }
  if (data.roll_over_start_date !== undefined) {
    updates.push(`roll_over_start_date = $${paramIndex++}`);
    values.push(data.roll_over_start_date);
  }
  if (data.capacities !== undefined) {
    updates.push(`capacities = $${paramIndex++}`);
    values.push(JSON.stringify(data.capacities));
  }

  values.push(budget_id, user.user_id);

  const result = await pool.query(
    `UPDATE ${BUDGETS} SET ${updates.join(", ")}
     WHERE ${BUDGET_ID} = $${paramIndex} AND ${USER_ID} = $${paramIndex + 1}
     RETURNING ${BUDGET_ID}`,
    values
  );

  return (result.rowCount || 0) > 0;
};

/**
 * Deletes a single budget with cascade.
 */
export const deleteBudget = async (
  user: MaskedUser,
  budget_id: string
): Promise<boolean> => {
  const { user_id } = user;

  // Get section IDs for this budget
  const sectionResult = await pool.query<{ section_id: string }>(
    `SELECT ${SECTION_ID} FROM ${SECTIONS}
     WHERE ${BUDGET_ID} = $1 AND ${USER_ID} = $2
     AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [budget_id, user_id]
  );
  const sectionIds = sectionResult.rows.map((r) => r.section_id);

  // Cascade: soft-delete categories of these sections
  if (sectionIds.length > 0) {
    const sPlaceholders = sectionIds.map((_, i) => `$${i + 2}`).join(", ");
    await pool.query(
      `UPDATE ${CATEGORIES} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
       WHERE ${SECTION_ID} IN (${sPlaceholders}) AND ${USER_ID} = $1`,
      [user_id, ...sectionIds]
    );
  }

  // Cascade: soft-delete sections
  await pool.query(
    `UPDATE ${SECTIONS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${BUDGET_ID} = $1 AND ${USER_ID} = $2`,
    [budget_id, user_id]
  );

  const result = await pool.query(
    `UPDATE ${BUDGETS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${BUDGET_ID} = $1 AND ${USER_ID} = $2
     RETURNING ${BUDGET_ID}`,
    [budget_id, user_id]
  );
  return (result.rowCount || 0) > 0;
};

/**
 * Deletes multiple budgets.
 */
export const deleteBudgets = async (
  user: MaskedUser,
  budget_ids: string[]
): Promise<{ deleted: number }> => {
  if (!budget_ids.length) return { deleted: 0 };

  const placeholders = budget_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE ${BUDGETS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${BUDGET_ID} IN (${placeholders}) AND ${USER_ID} = $1
     RETURNING ${BUDGET_ID}`,
    [user.user_id, ...budget_ids]
  );

  return { deleted: result.rowCount || 0 };
};

// =============================================
// Section Repository Functions
// =============================================

/**
 * Gets sections for a user.
 */
export const getSections = async (
  user: MaskedUser,
  budget_id?: string
): Promise<JSONSection[]> => {
  let result: QueryResult<SectionRow>;
  
  if (budget_id) {
    result = await pool.query<SectionRow>(
      `SELECT * FROM ${SECTIONS}
       WHERE ${BUDGET_ID} = $1 AND ${USER_ID} = $2
       AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [budget_id, user.user_id]
    );
  } else {
    result = await pool.query<SectionRow>(
      `SELECT * FROM ${SECTIONS}
       WHERE ${USER_ID} = $1
       AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [user.user_id]
    );
  }

  return result.rows.map(rowToSection);
};

/**
 * Creates a new section.
 */
export const createSection = async (
  user: MaskedUser,
  data: Partial<JSONSection>
): Promise<JSONSection | null> => {
  try {
    const result = await pool.query<SectionRow>(
      `INSERT INTO ${SECTIONS} (${USER_ID}, ${BUDGET_ID}, name, roll_over, roll_over_start_date, capacities, updated)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        user.user_id,
        data.budget_id,
        data.name || "New Section",
        data.roll_over || false,
        data.roll_over_start_date,
        JSON.stringify(data.capacities || []),
      ]
    );
    return result.rows.length > 0 ? rowToSection(result.rows[0]) : null;
  } catch (error) {
    console.error("Failed to create section:", error);
    return null;
  }
};

/**
 * Updates a section.
 */
export const updateSection = async (
  user: MaskedUser,
  section_id: string,
  data: Partial<JSONSection>
): Promise<boolean> => {
  const updates: string[] = ["updated = CURRENT_TIMESTAMP"];
  const values: (string | boolean | Date | undefined)[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(data.name);
  }
  if (data.roll_over !== undefined) {
    updates.push(`roll_over = $${paramIndex++}`);
    values.push(data.roll_over);
  }
  if (data.roll_over_start_date !== undefined) {
    updates.push(`roll_over_start_date = $${paramIndex++}`);
    values.push(data.roll_over_start_date);
  }
  if (data.capacities !== undefined) {
    updates.push(`capacities = $${paramIndex++}`);
    values.push(JSON.stringify(data.capacities));
  }

  values.push(section_id, user.user_id);

  const result = await pool.query(
    `UPDATE ${SECTIONS} SET ${updates.join(", ")}
     WHERE ${SECTION_ID} = $${paramIndex} AND ${USER_ID} = $${paramIndex + 1}
     RETURNING ${SECTION_ID}`,
    values
  );

  return (result.rowCount || 0) > 0;
};

/**
 * Deletes a single section with cascade.
 */
export const deleteSection = async (
  user: MaskedUser,
  section_id: string
): Promise<boolean> => {
  const { user_id } = user;

  // Cascade: soft-delete categories
  await pool.query(
    `UPDATE ${CATEGORIES} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${SECTION_ID} = $1 AND ${USER_ID} = $2`,
    [section_id, user_id]
  );

  const result = await pool.query(
    `UPDATE ${SECTIONS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${SECTION_ID} = $1 AND ${USER_ID} = $2
     RETURNING ${SECTION_ID}`,
    [section_id, user_id]
  );
  return (result.rowCount || 0) > 0;
};

/**
 * Deletes multiple sections.
 */
export const deleteSections = async (
  user: MaskedUser,
  section_ids: string[]
): Promise<{ deleted: number }> => {
  if (!section_ids.length) return { deleted: 0 };

  const placeholders = section_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE ${SECTIONS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${SECTION_ID} IN (${placeholders}) AND ${USER_ID} = $1
     RETURNING ${SECTION_ID}`,
    [user.user_id, ...section_ids]
  );

  return { deleted: result.rowCount || 0 };
};

// =============================================
// Category Repository Functions
// =============================================

/**
 * Gets categories for a user.
 */
export const getCategories = async (
  user: MaskedUser,
  section_id?: string
): Promise<JSONCategory[]> => {
  let result: QueryResult<CategoryRow>;
  
  if (section_id) {
    result = await pool.query<CategoryRow>(
      `SELECT * FROM ${CATEGORIES}
       WHERE ${SECTION_ID} = $1 AND ${USER_ID} = $2
       AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [section_id, user.user_id]
    );
  } else {
    result = await pool.query<CategoryRow>(
      `SELECT * FROM ${CATEGORIES}
       WHERE ${USER_ID} = $1
       AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [user.user_id]
    );
  }

  return result.rows.map(rowToCategory);
};

/**
 * Creates a new category.
 */
export const createCategory = async (
  user: MaskedUser,
  data: Partial<JSONCategory>
): Promise<JSONCategory | null> => {
  try {
    const result = await pool.query<CategoryRow>(
      `INSERT INTO ${CATEGORIES} (${USER_ID}, ${SECTION_ID}, name, roll_over, roll_over_start_date, capacities, updated)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        user.user_id,
        data.section_id,
        data.name || "New Category",
        data.roll_over || false,
        data.roll_over_start_date,
        JSON.stringify(data.capacities || []),
      ]
    );
    return result.rows.length > 0 ? rowToCategory(result.rows[0]) : null;
  } catch (error) {
    console.error("Failed to create category:", error);
    return null;
  }
};

/**
 * Updates a category.
 */
export const updateCategory = async (
  user: MaskedUser,
  category_id: string,
  data: Partial<JSONCategory>
): Promise<boolean> => {
  const updates: string[] = ["updated = CURRENT_TIMESTAMP"];
  const values: (string | boolean | Date | undefined)[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(data.name);
  }
  if (data.roll_over !== undefined) {
    updates.push(`roll_over = $${paramIndex++}`);
    values.push(data.roll_over);
  }
  if (data.roll_over_start_date !== undefined) {
    updates.push(`roll_over_start_date = $${paramIndex++}`);
    values.push(data.roll_over_start_date);
  }
  if (data.capacities !== undefined) {
    updates.push(`capacities = $${paramIndex++}`);
    values.push(JSON.stringify(data.capacities));
  }

  values.push(category_id, user.user_id);

  const result = await pool.query(
    `UPDATE ${CATEGORIES} SET ${updates.join(", ")}
     WHERE ${CATEGORY_ID} = $${paramIndex} AND ${USER_ID} = $${paramIndex + 1}
     RETURNING ${CATEGORY_ID}`,
    values
  );

  return (result.rowCount || 0) > 0;
};

/**
 * Deletes a single category.
 */
export const deleteCategory = async (
  user: MaskedUser,
  category_id: string
): Promise<boolean> => {
  const result = await pool.query(
    `UPDATE ${CATEGORIES} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${CATEGORY_ID} = $1 AND ${USER_ID} = $2
     RETURNING ${CATEGORY_ID}`,
    [category_id, user.user_id]
  );
  return (result.rowCount || 0) > 0;
};

/**
 * Deletes multiple categories.
 */
export const deleteCategories = async (
  user: MaskedUser,
  category_ids: string[]
): Promise<{ deleted: number }> => {
  if (!category_ids.length) return { deleted: 0 };

  const placeholders = category_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE ${CATEGORIES} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${CATEGORY_ID} IN (${placeholders}) AND ${USER_ID} = $1
     RETURNING ${CATEGORY_ID}`,
    [user.user_id, ...category_ids]
  );

  return { deleted: result.rowCount || 0 };
};
