import { JSONBudget, JSONSection, JSONCategory, JSONCapacity } from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";
import { QueryResult } from "pg";

// Database row interfaces (no more capacities column)
interface BudgetRow {
  budget_id: string;
  user_id?: string | null;
  name?: string | null;
  iso_currency_code?: string | null;
  roll_over?: boolean | null;
  roll_over_start_date?: Date | null;
  updated?: Date | null;
  is_deleted?: boolean | null;
  capacities: JSONCapacity[];
}

interface SectionRow {
  section_id: string;
  user_id?: string | null;
  budget_id: string;
  name?: string | null;
  roll_over?: boolean | null;
  roll_over_start_date?: Date | null;
  updated?: Date | null;
  is_deleted?: boolean | null;
  capacities: JSONCapacity[];
}

interface CategoryRow {
  category_id: string;
  user_id?: string | null;
  section_id: string;
  name?: string | null;
  roll_over?: boolean | null;
  roll_over_start_date?: Date | null;
  updated?: Date | null;
  is_deleted?: boolean | null;
  capacities: JSONCapacity[];
}

/**
 * Converts a Postgres row to budget (capacities attached separately).
 */
function rowToBudget(row: BudgetRow): JSONBudget {
  return {
    budget_id: row.budget_id,
    name: row.name || "Unnamed",
    iso_currency_code: row.iso_currency_code || "USD",
    capacities: row.capacities,
    roll_over: !!row.roll_over,
    roll_over_start_date: row.roll_over_start_date || undefined,
  };
}

/**
 * Gets all budgets for a user (with capacities attached).
 */
export const getBudgets = async (user: MaskedUser): Promise<JSONBudget[]> => {
  const { user_id } = user;
  const result = await pool.query<BudgetRow>(
    `SELECT * FROM budgets WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user_id],
  );

  return result.rows.map(rowToBudget);
};

/**
 * Gets a single budget by ID (with capacities attached).
 */
export const getBudget = async (
  user: MaskedUser,
  budget_id: string,
): Promise<JSONBudget | null> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM budgets WHERE budget_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [budget_id, user_id],
  );
  if (result.rows.length === 0) return null;

  return rowToBudget(result.rows[0]);
};

/**
 * Deletes budgets (soft delete).
 */
export const deleteBudgets = async (
  user: MaskedUser,
  budget_ids: string[],
): Promise<{ deleted: number }> => {
  if (!budget_ids.length) return { deleted: 0 };
  const { user_id } = user;

  const placeholders = budget_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE budgets SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE budget_id IN (${placeholders}) AND user_id = $1
     RETURNING budget_id`,
    [user_id, ...budget_ids],
  );

  return { deleted: result.rowCount || 0 };
};

// =====================================
// Sections
// =====================================

function rowToSection(row: SectionRow): JSONSection {
  return {
    section_id: row.section_id,
    budget_id: row.budget_id,
    name: row.name || "Unnamed",
    capacities: row.capacities,
    roll_over: !!row.roll_over,
    roll_over_start_date: row.roll_over_start_date || undefined,
  };
}

export const getSections = async (user: MaskedUser, budget_id?: string): Promise<JSONSection[]> => {
  const { user_id } = user;

  let result: QueryResult<SectionRow>;
  if (budget_id) {
    result = await pool.query(
      `SELECT * FROM sections 
       WHERE budget_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [budget_id, user_id],
    );
  } else {
    result = await pool.query(
      `SELECT * FROM sections WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [user_id],
    );
  }

  return result.rows.map(rowToSection);
};

export const deleteSections = async (
  user: MaskedUser,
  section_ids: string[],
): Promise<{ deleted: number }> => {
  if (!section_ids.length) return { deleted: 0 };
  const { user_id } = user;

  const placeholders = section_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE sections SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE section_id IN (${placeholders}) AND user_id = $1
     RETURNING section_id`,
    [user_id, ...section_ids],
  );

  return { deleted: result.rowCount || 0 };
};

// =====================================
// Categories
// =====================================

function rowToCategory(row: CategoryRow): JSONCategory {
  return {
    category_id: row.category_id,
    section_id: row.section_id,
    name: row.name || "Unnamed",
    capacities: row.capacities,
    roll_over: !!row.roll_over,
    roll_over_start_date: row.roll_over_start_date || undefined,
  };
}

export const getCategories = async (
  user: MaskedUser,
  section_id?: string,
): Promise<JSONCategory[]> => {
  const { user_id } = user;

  let result;
  if (section_id) {
    result = await pool.query<CategoryRow>(
      `SELECT * FROM categories 
       WHERE section_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [section_id, user_id],
    );
  } else {
    result = await pool.query<CategoryRow>(
      `SELECT * FROM categories WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [user_id],
    );
  }

  return result.rows.map(rowToCategory);
};

export const deleteCategories = async (
  user: MaskedUser,
  category_ids: string[],
): Promise<{ deleted: number }> => {
  if (!category_ids.length) return { deleted: 0 };
  const { user_id } = user;

  const placeholders = category_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE categories SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE category_id IN (${placeholders}) AND user_id = $1
     RETURNING category_id`,
    [user_id, ...category_ids],
  );

  return { deleted: result.rowCount || 0 };
};

// =====================================
// Search, Create, Update, Delete (singular) functions
// =====================================

/**
 * Searches budgets with optional filters.
 */
export const searchBudgets = async (
  user: MaskedUser,
  options: { budget_id?: string } = {},
): Promise<JSONBudget[]> => {
  const { user_id } = user;
  const conditions: string[] = ["user_id = $1", "(is_deleted IS NULL OR is_deleted = FALSE)"];
  const values: string[] = [user_id];
  let paramIndex = 2;

  if (options.budget_id) {
    conditions.push(`budget_id = $${paramIndex}`);
    values.push(options.budget_id);
    paramIndex++;
  }

  const result = await pool.query<BudgetRow>(
    `SELECT * FROM budgets WHERE ${conditions.join(" AND ")}`,
    values,
  );

  return result.rows.map(rowToBudget);
};

/**
 * Creates a new budget.
 */
export const createBudget = async (
  user: MaskedUser,
  data: Partial<JSONBudget>,
): Promise<JSONBudget | null> => {
  const { user_id } = user;

  try {
    const result = await pool.query(
      `INSERT INTO budgets (user_id, name, iso_currency_code, roll_over, roll_over_start_date, capacities, updated)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        user_id,
        data.name || "New Budget",
        data.iso_currency_code || "USD",
        data.roll_over || false,
        data.roll_over_start_date,
        JSON.stringify(data.capacities),
      ],
    );
    if (result.rows.length === 0) return null;

    return rowToBudget(result.rows[0]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to create budget:", message);
    return null;
  }
};

/**
 * Updates a budget.
 */
export const updateBudget = async (
  user: MaskedUser,
  budget_id: string,
  data: Partial<JSONBudget>,
): Promise<boolean> => {
  const { user_id } = user;
  const updates: string[] = ["updated = CURRENT_TIMESTAMP"];
  const values: (string | boolean | Date | undefined)[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    updates.push(`name = $${paramIndex}`);
    values.push(data.name);
    paramIndex++;
  }
  if (data.iso_currency_code !== undefined) {
    updates.push(`iso_currency_code = $${paramIndex}`);
    values.push(data.iso_currency_code);
    paramIndex++;
  }
  if (data.roll_over !== undefined) {
    updates.push(`roll_over = $${paramIndex}`);
    values.push(data.roll_over);
    paramIndex++;
  }
  if (data.roll_over_start_date !== undefined) {
    updates.push(`roll_over_start_date = $${paramIndex}`);
    values.push(data.roll_over_start_date);
    paramIndex++;
  }
  if (data.capacities !== undefined) {
    updates.push(`capacities = $${paramIndex}`);
    values.push(JSON.stringify(data.capacities));
    paramIndex++;
  }

  values.push(budget_id, user_id);

  const result = await pool.query(
    `UPDATE budgets SET ${updates.join(", ")} 
     WHERE budget_id = $${paramIndex} AND user_id = $${paramIndex + 1}
     RETURNING budget_id`,
    values,
  );

  return (result.rowCount || 0) > 0;
};

/**
 * Deletes a single budget (soft delete).
 * Cascades: soft-deletes child sections → their categories → their capacities.
 */
export const deleteBudget = async (user: MaskedUser, budget_id: string): Promise<boolean> => {
  const { user_id } = user;

  // Get section IDs for this budget
  const sectionResult = await pool.query<{ section_id: string }>(
    `SELECT section_id FROM sections WHERE budget_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [budget_id, user_id],
  );
  const sectionIds = sectionResult.rows.map((r) => r.section_id);

  // Get category IDs for these sections
  if (sectionIds.length > 0) {
    const sPlaceholders = sectionIds.map((_, i) => `$${i + 2}`).join(", ");

    // Cascade: soft-delete categories
    await pool.query(
      `UPDATE categories SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
       WHERE section_id IN (${sPlaceholders}) AND user_id = $1`,
      [user_id, ...sectionIds],
    );
  }

  // Cascade: soft-delete sections of this budget
  await pool.query(
    `UPDATE sections SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE budget_id = $1 AND user_id = $2`,
    [budget_id, user_id],
  );

  const result = await pool.query(
    `UPDATE budgets SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE budget_id = $1 AND user_id = $2
     RETURNING budget_id`,
    [budget_id, user_id],
  );
  return (result.rowCount || 0) > 0;
};

/**
 * Creates a new section.
 */
export const createSection = async (
  user: MaskedUser,
  data: Partial<JSONSection>,
): Promise<JSONSection | null> => {
  const { user_id } = user;

  try {
    const result = await pool.query(
      `INSERT INTO sections (user_id, budget_id, name, roll_over, roll_over_start_date, capacities, updated)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        user_id,
        data.budget_id,
        data.name || "New Section",
        data.roll_over || false,
        data.roll_over_start_date,
        JSON.stringify(data.capacities),
      ],
    );
    if (result.rows.length === 0) return null;

    return rowToSection(result.rows[0]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to create section:", message);
    return null;
  }
};

/**
 * Updates a section.
 */
export const updateSection = async (
  user: MaskedUser,
  section_id: string,
  data: Partial<JSONSection>,
): Promise<boolean> => {
  const { user_id } = user;
  const updates: string[] = ["updated = CURRENT_TIMESTAMP"];
  const values: (string | boolean | Date | undefined)[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    updates.push(`name = $${paramIndex}`);
    values.push(data.name);
    paramIndex++;
  }
  if (data.roll_over !== undefined) {
    updates.push(`roll_over = $${paramIndex}`);
    values.push(data.roll_over);
    paramIndex++;
  }
  if (data.roll_over_start_date !== undefined) {
    updates.push(`roll_over_start_date = $${paramIndex}`);
    values.push(data.roll_over_start_date);
    paramIndex++;
  }
  if (data.capacities !== undefined) {
    updates.push(`capacities = $${paramIndex}`);
    values.push(JSON.stringify(data.capacities));
    paramIndex++;
  }

  values.push(section_id, user_id);

  const result = await pool.query(
    `UPDATE sections SET ${updates.join(", ")} 
     WHERE section_id = $${paramIndex} AND user_id = $${paramIndex + 1}
     RETURNING section_id`,
    values,
  );

  return (result.rowCount || 0) > 0;
};

/**
 * Deletes a single section (soft delete).
 * Cascades: soft-deletes child categories → their capacities.
 */
export const deleteSection = async (user: MaskedUser, section_id: string): Promise<boolean> => {
  const { user_id } = user;

  // Cascade: soft-delete categories of this section
  await pool.query(
    `UPDATE categories SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE section_id = $1 AND user_id = $2`,
    [section_id, user_id],
  );

  const result = await pool.query(
    `UPDATE sections SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE section_id = $1 AND user_id = $2
     RETURNING section_id`,
    [section_id, user_id],
  );
  return (result.rowCount || 0) > 0;
};

/**
 * Creates a new category.
 */
export const createCategory = async (
  user: MaskedUser,
  data: Partial<JSONCategory>,
): Promise<JSONCategory | null> => {
  const { user_id } = user;

  try {
    const result = await pool.query(
      `INSERT INTO categories (user_id, section_id, name, roll_over, roll_over_start_date, capacities, updated)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        user_id,
        data.section_id,
        data.name || "New Category",
        data.roll_over || false,
        data.roll_over_start_date,
        JSON.stringify(data.capacities),
      ],
    );
    if (result.rows.length === 0) return null;

    return rowToCategory(result.rows[0]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to create category:", message);
    return null;
  }
};

/**
 * Updates a category.
 */
export const updateCategory = async (
  user: MaskedUser,
  category_id: string,
  data: Partial<JSONCategory>,
): Promise<boolean> => {
  const { user_id } = user;
  const updates: string[] = ["updated = CURRENT_TIMESTAMP"];
  const values: (string | boolean | Date | undefined)[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    updates.push(`name = $${paramIndex}`);
    values.push(data.name);
    paramIndex++;
  }
  if (data.roll_over !== undefined) {
    updates.push(`roll_over = $${paramIndex}`);
    values.push(data.roll_over);
    paramIndex++;
  }
  if (data.roll_over_start_date !== undefined) {
    updates.push(`roll_over_start_date = $${paramIndex}`);
    values.push(data.roll_over_start_date);
    paramIndex++;
  }
  if (data.capacities !== undefined) {
    updates.push(`capacities = $${paramIndex}`);
    values.push(JSON.stringify(data.capacities));
    paramIndex++;
  }

  values.push(category_id, user_id);

  const result = await pool.query(
    `UPDATE categories SET ${updates.join(", ")} 
     WHERE category_id = $${paramIndex} AND user_id = $${paramIndex + 1}
     RETURNING category_id`,
    values,
  );

  return (result.rowCount || 0) > 0;
};

/**
 * Deletes a single category (soft delete).
 * Cascades: soft-deletes its capacities.
 */
export const deleteCategory = async (user: MaskedUser, category_id: string): Promise<boolean> => {
  const { user_id } = user;

  const result = await pool.query(
    `UPDATE categories SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE category_id = $1 AND user_id = $2
     RETURNING category_id`,
    [category_id, user_id],
  );
  return (result.rowCount || 0) > 0;
};
