import { JSONBudget, JSONSection, JSONCategory, JSONCapacity } from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";
import { getCapacitiesByParents, upsertCapacities, deleteCapacitiesByParent, ParentType } from "./capacities";

type PartialBudget = { budget_id?: string } & Partial<JSONBudget>;
type PartialSection = { section_id?: string } & Partial<JSONSection>;
type PartialCategory = { category_id?: string } & Partial<JSONCategory>;

// Database row interfaces (no more capacities column)
interface BudgetRow {
  budget_id: string;
  user_id?: string;
  name?: string;
  iso_currency_code?: string;
  roll_over?: boolean;
  roll_over_start_date?: string | Date;
  updated?: Date;
  is_deleted?: boolean;
}

interface SectionRow {
  section_id: string;
  user_id?: string;
  budget_id?: string;
  name?: string;
  roll_over?: boolean;
  roll_over_start_date?: string | Date;
  updated?: Date;
  is_deleted?: boolean;
}

interface CategoryRow {
  category_id: string;
  user_id?: string;
  section_id?: string;
  name?: string;
  roll_over?: boolean;
  roll_over_start_date?: string | Date;
  updated?: Date;
  is_deleted?: boolean;
}

/**
 * Converts a budget to Postgres row (no capacities column).
 */
function budgetToRow(budget: PartialBudget): Partial<BudgetRow> {
  const row: Partial<BudgetRow> = {};
  
  if (budget.budget_id !== undefined) row.budget_id = budget.budget_id;
  if (budget.name !== undefined) row.name = budget.name;
  if (budget.iso_currency_code !== undefined) row.iso_currency_code = budget.iso_currency_code;
  if (budget.roll_over !== undefined) row.roll_over = budget.roll_over;
  if (budget.roll_over_start_date !== undefined) row.roll_over_start_date = budget.roll_over_start_date;
  
  return row;
}

/**
 * Converts a Postgres row to budget (capacities attached separately).
 */
function rowToBudget(row: BudgetRow, capacities: JSONCapacity[] = []): JSONBudget {
  return {
    budget_id: row.budget_id,
    user_id: row.user_id,
    name: row.name,
    iso_currency_code: row.iso_currency_code,
    capacities,
    roll_over: row.roll_over,
    roll_over_start_date: row.roll_over_start_date,
  } as JSONBudget;
}

/**
 * Upserts budgets for a user.
 */
export const upsertBudgets = async (
  user: MaskedUser,
  budgets: PartialBudget[]
) => {
  if (!budgets.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];

  for (const budget of budgets) {
    const row = budgetToRow(budget);
    row.user_id = user_id;
    
    try {
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = values.map((_, i) => `$${i + 1}`);
      
      if (budget.budget_id) {
        // Update existing
        const updateClauses = columns
          .filter(col => col !== "budget_id" && col !== "user_id")
          .map(col => `${col} = EXCLUDED.${col}`);
        updateClauses.push("updated = CURRENT_TIMESTAMP");
        
        const query = `
          INSERT INTO budgets (${columns.join(", ")}, updated)
          VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
          ON CONFLICT (budget_id) DO UPDATE SET
            ${updateClauses.join(", ")}
          WHERE budgets.user_id = $${columns.indexOf("user_id") + 1}
          RETURNING budget_id
        `;
        
        const result = await pool.query(query, values);

        // Upsert capacities separately
        if (budget.capacities !== undefined) {
          await upsertCapacities(user, budget.budget_id, "budget", budget.capacities);
        }

        results.push({
          update: { _id: budget.budget_id },
          status: result.rowCount ? 200 : 404,
        });
      } else {
        // Insert new with auto-generated UUID
        const insertColumns = columns.filter(c => c !== "budget_id");
        const insertValues = values.filter((_, i) => columns[i] !== "budget_id");
        const insertPlaceholders = insertValues.map((_, i) => `$${i + 1}`);
        
        const query = `
          INSERT INTO budgets (${insertColumns.join(", ")}, updated)
          VALUES (${insertPlaceholders.join(", ")}, CURRENT_TIMESTAMP)
          RETURNING budget_id
        `;
        
        const result = await pool.query(query, insertValues);
        const id = result.rows[0]?.budget_id;

        // Upsert capacities separately
        if (id && budget.capacities) {
          await upsertCapacities(user, id, "budget", budget.capacities);
        }

        results.push({
          update: { _id: id },
          status: result.rowCount ? 201 : 500,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to upsert budget:`, message);
      results.push({
        update: { _id: budget.budget_id || "unknown" },
        status: 500,
      });
    }
  }

  return results;
};

/**
 * Gets all budgets for a user (with capacities attached).
 */
export const getBudgets = async (user: MaskedUser): Promise<JSONBudget[]> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM budgets WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user_id]
  );

  const budgetIds = result.rows.map((r: BudgetRow) => r.budget_id);
  const capsMap = await getCapacitiesByParents(budgetIds, "budget");

  return result.rows.map((row: BudgetRow) => rowToBudget(row, capsMap.get(row.budget_id) || []));
};

/**
 * Gets a single budget by ID (with capacities attached).
 */
export const getBudget = async (
  user: MaskedUser,
  budget_id: string
): Promise<JSONBudget | null> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM budgets WHERE budget_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [budget_id, user_id]
  );
  if (result.rows.length === 0) return null;

  const capsMap = await getCapacitiesByParents([budget_id], "budget");
  return rowToBudget(result.rows[0], capsMap.get(budget_id) || []);
};

/**
 * Deletes budgets (soft delete).
 */
export const deleteBudgets = async (
  user: MaskedUser,
  budget_ids: string[]
): Promise<{ deleted: number }> => {
  if (!budget_ids.length) return { deleted: 0 };
  const { user_id } = user;
  
  // Cascade: soft-delete capacities for these budgets
  for (const bid of budget_ids) {
    await deleteCapacitiesByParent(user, bid);
  }

  const placeholders = budget_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE budgets SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE budget_id IN (${placeholders}) AND user_id = $1
     RETURNING budget_id`,
    [user_id, ...budget_ids]
  );
  
  return { deleted: result.rowCount || 0 };
};

// =====================================
// Sections
// =====================================

function sectionToRow(section: PartialSection): Partial<SectionRow> {
  const row: Partial<SectionRow> = {};
  
  if (section.section_id !== undefined) row.section_id = section.section_id;
  if (section.budget_id !== undefined) row.budget_id = section.budget_id;
  if (section.name !== undefined) row.name = section.name;
  if (section.roll_over !== undefined) row.roll_over = section.roll_over;
  if (section.roll_over_start_date !== undefined) row.roll_over_start_date = section.roll_over_start_date;
  
  return row;
}

function rowToSection(row: SectionRow, capacities: JSONCapacity[] = []): JSONSection {
  return {
    section_id: row.section_id,
    user_id: row.user_id,
    budget_id: row.budget_id,
    name: row.name,
    capacities,
    roll_over: row.roll_over,
    roll_over_start_date: row.roll_over_start_date,
  } as JSONSection;
}

export const upsertSections = async (
  user: MaskedUser,
  sections: PartialSection[]
) => {
  if (!sections.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];

  for (const section of sections) {
    const row = sectionToRow(section);
    row.user_id = user_id;
    
    try {
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = values.map((_, i) => `$${i + 1}`);
      
      if (section.section_id) {
        const updateClauses = columns
          .filter(col => col !== "section_id" && col !== "user_id")
          .map(col => `${col} = EXCLUDED.${col}`);
        updateClauses.push("updated = CURRENT_TIMESTAMP");
        
        const query = `
          INSERT INTO sections (${columns.join(", ")}, updated)
          VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
          ON CONFLICT (section_id) DO UPDATE SET
            ${updateClauses.join(", ")}
          WHERE sections.user_id = $${columns.indexOf("user_id") + 1}
          RETURNING section_id
        `;
        
        const result = await pool.query(query, values);

        // Upsert capacities separately
        if (section.capacities !== undefined) {
          await upsertCapacities(user, section.section_id, "section", section.capacities);
        }

        results.push({
          update: { _id: section.section_id },
          status: result.rowCount ? 200 : 404,
        });
      } else {
        const insertColumns = columns.filter(c => c !== "section_id");
        const insertValues = values.filter((_, i) => columns[i] !== "section_id");
        const insertPlaceholders = insertValues.map((_, i) => `$${i + 1}`);
        
        const query = `
          INSERT INTO sections (${insertColumns.join(", ")}, updated)
          VALUES (${insertPlaceholders.join(", ")}, CURRENT_TIMESTAMP)
          RETURNING section_id
        `;
        
        const result = await pool.query(query, insertValues);
        const id = result.rows[0]?.section_id;

        // Upsert capacities separately
        if (id && section.capacities) {
          await upsertCapacities(user, id, "section", section.capacities);
        }

        results.push({
          update: { _id: id },
          status: result.rowCount ? 201 : 500,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to upsert section:`, message);
      results.push({
        update: { _id: section.section_id || "unknown" },
        status: 500,
      });
    }
  }

  return results;
};

export const getSections = async (
  user: MaskedUser,
  budget_id?: string
): Promise<JSONSection[]> => {
  const { user_id } = user;
  
  let result;
  if (budget_id) {
    result = await pool.query(
      `SELECT * FROM sections 
       WHERE budget_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [budget_id, user_id]
    );
  } else {
    result = await pool.query(
      `SELECT * FROM sections WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [user_id]
    );
  }

  const sectionIds = result.rows.map((r: SectionRow) => r.section_id);
  const capsMap = await getCapacitiesByParents(sectionIds, "section");

  return result.rows.map((row: SectionRow) => rowToSection(row, capsMap.get(row.section_id) || []));
};

export const deleteSections = async (
  user: MaskedUser,
  section_ids: string[]
): Promise<{ deleted: number }> => {
  if (!section_ids.length) return { deleted: 0 };
  const { user_id } = user;

  // Cascade: soft-delete capacities for these sections
  for (const sid of section_ids) {
    await deleteCapacitiesByParent(user, sid);
  }
  
  const placeholders = section_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE sections SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE section_id IN (${placeholders}) AND user_id = $1
     RETURNING section_id`,
    [user_id, ...section_ids]
  );
  
  return { deleted: result.rowCount || 0 };
};

// =====================================
// Categories
// =====================================

function categoryToRow(category: PartialCategory): Partial<CategoryRow> {
  const row: Partial<CategoryRow> = {};
  
  if (category.category_id !== undefined) row.category_id = category.category_id;
  if (category.section_id !== undefined) row.section_id = category.section_id;
  if (category.name !== undefined) row.name = category.name;
  if (category.roll_over !== undefined) row.roll_over = category.roll_over;
  if (category.roll_over_start_date !== undefined) row.roll_over_start_date = category.roll_over_start_date;
  
  return row;
}

function rowToCategory(row: CategoryRow, capacities: JSONCapacity[] = []): JSONCategory {
  return {
    category_id: row.category_id,
    user_id: row.user_id,
    section_id: row.section_id,
    name: row.name,
    capacities,
    roll_over: row.roll_over,
    roll_over_start_date: row.roll_over_start_date,
  } as JSONCategory;
}

export const upsertCategories = async (
  user: MaskedUser,
  categories: PartialCategory[]
) => {
  if (!categories.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];

  for (const category of categories) {
    const row = categoryToRow(category);
    row.user_id = user_id;
    
    try {
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = values.map((_, i) => `$${i + 1}`);
      
      if (category.category_id) {
        const updateClauses = columns
          .filter(col => col !== "category_id" && col !== "user_id")
          .map(col => `${col} = EXCLUDED.${col}`);
        updateClauses.push("updated = CURRENT_TIMESTAMP");
        
        const query = `
          INSERT INTO categories (${columns.join(", ")}, updated)
          VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
          ON CONFLICT (category_id) DO UPDATE SET
            ${updateClauses.join(", ")}
          WHERE categories.user_id = $${columns.indexOf("user_id") + 1}
          RETURNING category_id
        `;
        
        const result = await pool.query(query, values);

        // Upsert capacities separately
        if (category.capacities !== undefined) {
          await upsertCapacities(user, category.category_id, "category", category.capacities);
        }

        results.push({
          update: { _id: category.category_id },
          status: result.rowCount ? 200 : 404,
        });
      } else {
        const insertColumns = columns.filter(c => c !== "category_id");
        const insertValues = values.filter((_, i) => columns[i] !== "category_id");
        const insertPlaceholders = insertValues.map((_, i) => `$${i + 1}`);
        
        const query = `
          INSERT INTO categories (${insertColumns.join(", ")}, updated)
          VALUES (${insertPlaceholders.join(", ")}, CURRENT_TIMESTAMP)
          RETURNING category_id
        `;
        
        const result = await pool.query(query, insertValues);
        const id = result.rows[0]?.category_id;

        // Upsert capacities separately
        if (id && category.capacities) {
          await upsertCapacities(user, id, "category", category.capacities);
        }

        results.push({
          update: { _id: id },
          status: result.rowCount ? 201 : 500,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to upsert category:`, message);
      results.push({
        update: { _id: category.category_id || "unknown" },
        status: 500,
      });
    }
  }

  return results;
};

export const getCategories = async (
  user: MaskedUser,
  section_id?: string
): Promise<JSONCategory[]> => {
  const { user_id } = user;
  
  let result;
  if (section_id) {
    result = await pool.query(
      `SELECT * FROM categories 
       WHERE section_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [section_id, user_id]
    );
  } else {
    result = await pool.query(
      `SELECT * FROM categories WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [user_id]
    );
  }

  const categoryIds = result.rows.map((r: CategoryRow) => r.category_id);
  const capsMap = await getCapacitiesByParents(categoryIds, "category");

  return result.rows.map((row: CategoryRow) => rowToCategory(row, capsMap.get(row.category_id) || []));
};

export const deleteCategories = async (
  user: MaskedUser,
  category_ids: string[]
): Promise<{ deleted: number }> => {
  if (!category_ids.length) return { deleted: 0 };
  const { user_id } = user;

  // Cascade: soft-delete capacities for these categories
  for (const cid of category_ids) {
    await deleteCapacitiesByParent(user, cid);
  }
  
  const placeholders = category_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE categories SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE category_id IN (${placeholders}) AND user_id = $1
     RETURNING category_id`,
    [user_id, ...category_ids]
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
  options: { budget_id?: string } = {}
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

  const result = await pool.query(
    `SELECT * FROM budgets WHERE ${conditions.join(" AND ")}`,
    values
  );

  const budgetIds = result.rows.map((r: BudgetRow) => r.budget_id);
  const capsMap = await getCapacitiesByParents(budgetIds, "budget");

  return result.rows.map((row: BudgetRow) => rowToBudget(row, capsMap.get(row.budget_id) || []));
};

/**
 * Creates a new budget.
 */
export const createBudget = async (
  user: MaskedUser,
  data: Partial<JSONBudget>
): Promise<JSONBudget | null> => {
  const { user_id } = user;
  
  try {
    const result = await pool.query(
      `INSERT INTO budgets (user_id, name, iso_currency_code, roll_over, roll_over_start_date, updated)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        user_id,
        data.name || "New Budget",
        data.iso_currency_code || "USD",
        data.roll_over || false,
        data.roll_over_start_date,
      ]
    );
    if (result.rows.length === 0) return null;

    const budgetId = result.rows[0].budget_id;
    const capacities = data.capacities || [];
    if (capacities.length > 0) {
      await upsertCapacities(user, budgetId, "budget", capacities);
    }

    return rowToBudget(result.rows[0], capacities);
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
  data: Partial<JSONBudget>
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

  values.push(budget_id, user_id);

  const result = await pool.query(
    `UPDATE budgets SET ${updates.join(", ")} 
     WHERE budget_id = $${paramIndex} AND user_id = $${paramIndex + 1}
     RETURNING budget_id`,
    values
  );

  // Upsert capacities separately
  if (data.capacities !== undefined) {
    await upsertCapacities(user, budget_id, "budget", data.capacities);
  }

  return (result.rowCount || 0) > 0;
};

/**
 * Deletes a single budget (soft delete).
 * Cascades: soft-deletes child sections → their categories → their capacities.
 */
export const deleteBudget = async (
  user: MaskedUser,
  budget_id: string
): Promise<boolean> => {
  const { user_id } = user;

  // Get section IDs for this budget
  const sectionResult = await pool.query<{ section_id: string }>(
    `SELECT section_id FROM sections WHERE budget_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [budget_id, user_id]
  );
  const sectionIds = sectionResult.rows.map((r) => r.section_id);

  // Get category IDs for these sections
  if (sectionIds.length > 0) {
    const sPlaceholders = sectionIds.map((_, i) => `$${i + 2}`).join(", ");
    const categoryResult = await pool.query<{ category_id: string }>(
      `SELECT category_id FROM categories WHERE section_id IN (${sPlaceholders}) AND user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [user_id, ...sectionIds]
    );
    const categoryIds = categoryResult.rows.map((r) => r.category_id);

    // Cascade: soft-delete capacities for categories
    for (const cid of categoryIds) {
      await deleteCapacitiesByParent(user, cid);
    }

    // Cascade: soft-delete categories
    await pool.query(
      `UPDATE categories SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
       WHERE section_id IN (${sPlaceholders}) AND user_id = $1`,
      [user_id, ...sectionIds]
    );
  }

  // Cascade: soft-delete capacities for sections
  for (const sid of sectionIds) {
    await deleteCapacitiesByParent(user, sid);
  }

  // Cascade: soft-delete sections of this budget
  await pool.query(
    `UPDATE sections SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE budget_id = $1 AND user_id = $2`,
    [budget_id, user_id]
  );

  // Cascade: soft-delete capacities for the budget itself
  await deleteCapacitiesByParent(user, budget_id);

  const result = await pool.query(
    `UPDATE budgets SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE budget_id = $1 AND user_id = $2
     RETURNING budget_id`,
    [budget_id, user_id]
  );
  return (result.rowCount || 0) > 0;
};

/**
 * Creates a new section.
 */
export const createSection = async (
  user: MaskedUser,
  data: Partial<JSONSection>
): Promise<JSONSection | null> => {
  const { user_id } = user;
  
  try {
    const result = await pool.query(
      `INSERT INTO sections (user_id, budget_id, name, roll_over, roll_over_start_date, updated)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        user_id,
        data.budget_id,
        data.name || "New Section",
        data.roll_over || false,
        data.roll_over_start_date,
      ]
    );
    if (result.rows.length === 0) return null;

    const sectionId = result.rows[0].section_id;
    const capacities = data.capacities || [];
    if (capacities.length > 0) {
      await upsertCapacities(user, sectionId, "section", capacities);
    }

    return rowToSection(result.rows[0], capacities);
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
  data: Partial<JSONSection>
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

  values.push(section_id, user_id);

  const result = await pool.query(
    `UPDATE sections SET ${updates.join(", ")} 
     WHERE section_id = $${paramIndex} AND user_id = $${paramIndex + 1}
     RETURNING section_id`,
    values
  );

  // Upsert capacities separately
  if (data.capacities !== undefined) {
    await upsertCapacities(user, section_id, "section", data.capacities);
  }

  return (result.rowCount || 0) > 0;
};

/**
 * Deletes a single section (soft delete).
 * Cascades: soft-deletes child categories → their capacities.
 */
export const deleteSection = async (
  user: MaskedUser,
  section_id: string
): Promise<boolean> => {
  const { user_id } = user;

  // Get category IDs for this section
  const categoryResult = await pool.query<{ category_id: string }>(
    `SELECT category_id FROM categories WHERE section_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [section_id, user_id]
  );
  const categoryIds = categoryResult.rows.map((r) => r.category_id);

  // Cascade: soft-delete capacities for categories
  for (const cid of categoryIds) {
    await deleteCapacitiesByParent(user, cid);
  }

  // Cascade: soft-delete categories of this section
  await pool.query(
    `UPDATE categories SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE section_id = $1 AND user_id = $2`,
    [section_id, user_id]
  );

  // Cascade: soft-delete capacities for the section itself
  await deleteCapacitiesByParent(user, section_id);

  const result = await pool.query(
    `UPDATE sections SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE section_id = $1 AND user_id = $2
     RETURNING section_id`,
    [section_id, user_id]
  );
  return (result.rowCount || 0) > 0;
};

/**
 * Creates a new category.
 */
export const createCategory = async (
  user: MaskedUser,
  data: Partial<JSONCategory>
): Promise<JSONCategory | null> => {
  const { user_id } = user;
  
  try {
    const result = await pool.query(
      `INSERT INTO categories (user_id, section_id, name, roll_over, roll_over_start_date, updated)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        user_id,
        data.section_id,
        data.name || "New Category",
        data.roll_over || false,
        data.roll_over_start_date,
      ]
    );
    if (result.rows.length === 0) return null;

    const categoryId = result.rows[0].category_id;
    const capacities = data.capacities || [];
    if (capacities.length > 0) {
      await upsertCapacities(user, categoryId, "category", capacities);
    }

    return rowToCategory(result.rows[0], capacities);
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
  data: Partial<JSONCategory>
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

  values.push(category_id, user_id);

  const result = await pool.query(
    `UPDATE categories SET ${updates.join(", ")} 
     WHERE category_id = $${paramIndex} AND user_id = $${paramIndex + 1}
     RETURNING category_id`,
    values
  );

  // Upsert capacities separately
  if (data.capacities !== undefined) {
    await upsertCapacities(user, category_id, "category", data.capacities);
  }

  return (result.rowCount || 0) > 0;
};

/**
 * Deletes a single category (soft delete).
 * Cascades: soft-deletes its capacities.
 */
export const deleteCategory = async (
  user: MaskedUser,
  category_id: string
): Promise<boolean> => {
  const { user_id } = user;

  // Cascade: soft-delete capacities
  await deleteCapacitiesByParent(user, category_id);

  const result = await pool.query(
    `UPDATE categories SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE category_id = $1 AND user_id = $2
     RETURNING category_id`,
    [category_id, user_id]
  );
  return (result.rowCount || 0) > 0;
};
