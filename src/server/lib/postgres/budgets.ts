import { JSONBudget, JSONSection, JSONCategory, Capacity } from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";

// Note: capacities remains as JSONB since it's an array with complex nested structure
// that requires array operations (adding/removing elements)

type PartialBudget = { budget_id?: string } & Partial<JSONBudget>;
type PartialSection = { section_id?: string } & Partial<JSONSection>;
type PartialCategory = { category_id?: string } & Partial<JSONCategory>;

/**
 * Converts a budget to Postgres row.
 */
function budgetToRow(budget: PartialBudget): Record<string, any> {
  const row: Record<string, any> = {};
  
  if (budget.budget_id !== undefined) row.budget_id = budget.budget_id;
  if (budget.name !== undefined) row.name = budget.name;
  if (budget.iso_currency_code !== undefined) row.iso_currency_code = budget.iso_currency_code;
  if (budget.capacities !== undefined) row.capacities = JSON.stringify(budget.capacities);
  if (budget.roll_over !== undefined) row.roll_over = budget.roll_over;
  if (budget.roll_over_start_date !== undefined) row.roll_over_start_date = budget.roll_over_start_date;
  
  return row;
}

/**
 * Converts a Postgres row to budget.
 */
function rowToBudget(row: Record<string, any>): JSONBudget {
  return {
    budget_id: row.budget_id,
    user_id: row.user_id,
    name: row.name,
    iso_currency_code: row.iso_currency_code,
    capacities: typeof row.capacities === 'string' ? JSON.parse(row.capacities) : row.capacities || [],
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
        results.push({
          update: { _id: id },
          status: result.rowCount ? 201 : 500,
        });
      }
    } catch (error: any) {
      console.error(`Failed to upsert budget:`, error.message);
      results.push({
        update: { _id: budget.budget_id || "unknown" },
        status: 500,
      });
    }
  }

  return results;
};

/**
 * Gets all budgets for a user.
 */
export const getBudgets = async (user: MaskedUser): Promise<JSONBudget[]> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM budgets WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user_id]
  );
  return result.rows.map(rowToBudget);
};

/**
 * Gets a single budget by ID.
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
  return result.rows.length > 0 ? rowToBudget(result.rows[0]) : null;
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

function sectionToRow(section: PartialSection): Record<string, any> {
  const row: Record<string, any> = {};
  
  if (section.section_id !== undefined) row.section_id = section.section_id;
  if (section.budget_id !== undefined) row.budget_id = section.budget_id;
  if (section.name !== undefined) row.name = section.name;
  if (section.capacities !== undefined) row.capacities = JSON.stringify(section.capacities);
  if (section.roll_over !== undefined) row.roll_over = section.roll_over;
  if (section.roll_over_start_date !== undefined) row.roll_over_start_date = section.roll_over_start_date;
  
  return row;
}

function rowToSection(row: Record<string, any>): JSONSection {
  return {
    section_id: row.section_id,
    user_id: row.user_id,
    budget_id: row.budget_id,
    name: row.name,
    capacities: typeof row.capacities === 'string' ? JSON.parse(row.capacities) : row.capacities || [],
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
        results.push({
          update: { _id: id },
          status: result.rowCount ? 201 : 500,
        });
      }
    } catch (error: any) {
      console.error(`Failed to upsert section:`, error.message);
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
  
  if (budget_id) {
    const result = await pool.query(
      `SELECT * FROM sections 
       WHERE budget_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [budget_id, user_id]
    );
    return result.rows.map(rowToSection);
  }
  
  const result = await pool.query(
    `SELECT * FROM sections WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user_id]
  );
  return result.rows.map(rowToSection);
};

export const deleteSections = async (
  user: MaskedUser,
  section_ids: string[]
): Promise<{ deleted: number }> => {
  if (!section_ids.length) return { deleted: 0 };
  const { user_id } = user;
  
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

function categoryToRow(category: PartialCategory): Record<string, any> {
  const row: Record<string, any> = {};
  
  if (category.category_id !== undefined) row.category_id = category.category_id;
  if (category.section_id !== undefined) row.section_id = category.section_id;
  if (category.name !== undefined) row.name = category.name;
  if (category.capacities !== undefined) row.capacities = JSON.stringify(category.capacities);
  if (category.roll_over !== undefined) row.roll_over = category.roll_over;
  if (category.roll_over_start_date !== undefined) row.roll_over_start_date = category.roll_over_start_date;
  
  return row;
}

function rowToCategory(row: Record<string, any>): JSONCategory {
  return {
    category_id: row.category_id,
    user_id: row.user_id,
    section_id: row.section_id,
    name: row.name,
    capacities: typeof row.capacities === 'string' ? JSON.parse(row.capacities) : row.capacities || [],
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
        results.push({
          update: { _id: id },
          status: result.rowCount ? 201 : 500,
        });
      }
    } catch (error: any) {
      console.error(`Failed to upsert category:`, error.message);
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
  
  if (section_id) {
    const result = await pool.query(
      `SELECT * FROM categories 
       WHERE section_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
      [section_id, user_id]
    );
    return result.rows.map(rowToCategory);
  }
  
  const result = await pool.query(
    `SELECT * FROM categories WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user_id]
  );
  return result.rows.map(rowToCategory);
};

export const deleteCategories = async (
  user: MaskedUser,
  category_ids: string[]
): Promise<{ deleted: number }> => {
  if (!category_ids.length) return { deleted: 0 };
  const { user_id } = user;
  
  const placeholders = category_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE categories SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE category_id IN (${placeholders}) AND user_id = $1
     RETURNING category_id`,
    [user_id, ...category_ids]
  );
  
  return { deleted: result.rowCount || 0 };
};
