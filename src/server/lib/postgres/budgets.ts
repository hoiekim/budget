import { JSONBudget, JSONSection, JSONCategory, getRandomId } from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";

/**
 * Creates a document that represents a budget.
 * Note: Budget > Section > Category
 * @param user
 * @returns A promise with the created budget id
 */
export const createBudget = async (user: MaskedUser) => {
  const { user_id } = user;
  const updated = new Date().toISOString();

  const budget = {
    name: "Unnamed",
    iso_currency_code: "USD",
    capacities: [{ capacity_id: getRandomId(), month: 0 }],
    roll_over: false,
  };

  const result = await pool.query(
    `INSERT INTO budgets (user_id, name, iso_currency_code, capacities, roll_over, updated)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING budget_id`,
    [user_id, budget.name, budget.iso_currency_code, JSON.stringify(budget.capacities), budget.roll_over, updated]
  );

  return { _id: result.rows[0].budget_id };
};

export type PartialBudget = { budget_id: string } & Partial<JSONBudget>;

/**
 * Updates budget document with given object.
 * @param user
 * @param budget
 * @returns A promise with the update result
 */
export const updateBudget = async (user: MaskedUser, budget: PartialBudget) => {
  const { user_id } = user;
  const { budget_id, name, iso_currency_code, capacities, roll_over, roll_over_start_date } = budget;
  const updated = new Date().toISOString();

  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(name);
  }
  if (iso_currency_code !== undefined) {
    updates.push(`iso_currency_code = $${paramIndex++}`);
    values.push(iso_currency_code);
  }
  if (capacities !== undefined) {
    updates.push(`capacities = $${paramIndex++}`);
    values.push(JSON.stringify(capacities));
  }
  if (roll_over !== undefined) {
    updates.push(`roll_over = $${paramIndex++}`);
    values.push(roll_over);
  }
  if (roll_over_start_date !== undefined) {
    updates.push(`roll_over_start_date = $${paramIndex++}`);
    values.push(roll_over_start_date);
  }

  updates.push(`updated = $${paramIndex++}`);
  values.push(updated);

  values.push(budget_id);
  values.push(user_id);

  const result = await pool.query(
    `UPDATE budgets SET ${updates.join(", ")} 
     WHERE budget_id = $${paramIndex++} AND user_id = $${paramIndex}`,
    values
  );

  return result;
};

/**
 * Deletes budget document with given id.
 * Also deletes associated sections and categories.
 * @param user
 * @param budget_id
 * @returns A promise with the delete result
 */
export const deleteBudget = async (user: MaskedUser, budget_id: string) => {
  if (!budget_id) return;
  const { user_id } = user;

  // Get all section_ids for this budget
  const sectionsResult = await pool.query(
    `SELECT section_id FROM sections WHERE budget_id = $1 AND user_id = $2`,
    [budget_id, user_id]
  );
  const sectionIds = sectionsResult.rows.map((r) => r.section_id);

  // Delete categories for those sections
  if (sectionIds.length > 0) {
    await pool.query(
      `DELETE FROM categories WHERE user_id = $1 AND section_id = ANY($2)`,
      [user_id, sectionIds]
    );
  }

  // Delete sections
  await pool.query(
    `DELETE FROM sections WHERE user_id = $1 AND budget_id = $2`,
    [user_id, budget_id]
  );

  // Delete budget
  const result = await pool.query(
    `DELETE FROM budgets WHERE user_id = $1 AND budget_id = $2`,
    [user_id, budget_id]
  );

  return { deleted: result.rowCount };
};

/**
 * Creates a document that represents a section.
 * Note: Budget > Section > Category
 * @param user
 * @param budget_id parent budget's id
 * @returns A promise with the created section id
 */
export const createSection = async (user: MaskedUser, budget_id: string) => {
  const { user_id } = user;
  const updated = new Date().toISOString();

  const section = {
    name: "Unnamed",
    budget_id,
    capacities: [{ capacity_id: getRandomId(), month: 0 }],
    roll_over: false,
  };

  const result = await pool.query(
    `INSERT INTO sections (user_id, budget_id, name, capacities, roll_over, updated)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING section_id`,
    [user_id, budget_id, section.name, JSON.stringify(section.capacities), section.roll_over, updated]
  );

  return { _id: result.rows[0].section_id };
};

export type PartialSection = { section_id: string } & Partial<JSONSection>;

/**
 * Updates section document with given object.
 * @param user
 * @param section
 * @returns A promise with the update result
 */
export const updateSection = async (user: MaskedUser, section: PartialSection) => {
  const { user_id } = user;
  const { section_id, name, budget_id, capacities, roll_over, roll_over_start_date } = section;
  const updated = new Date().toISOString();

  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(name);
  }
  if (budget_id !== undefined) {
    updates.push(`budget_id = $${paramIndex++}`);
    values.push(budget_id);
  }
  if (capacities !== undefined) {
    updates.push(`capacities = $${paramIndex++}`);
    values.push(JSON.stringify(capacities));
  }
  if (roll_over !== undefined) {
    updates.push(`roll_over = $${paramIndex++}`);
    values.push(roll_over);
  }
  if (roll_over_start_date !== undefined) {
    updates.push(`roll_over_start_date = $${paramIndex++}`);
    values.push(roll_over_start_date);
  }

  updates.push(`updated = $${paramIndex++}`);
  values.push(updated);

  values.push(section_id);
  values.push(user_id);

  const result = await pool.query(
    `UPDATE sections SET ${updates.join(", ")} 
     WHERE section_id = $${paramIndex++} AND user_id = $${paramIndex}`,
    values
  );

  return result;
};

/**
 * Deletes section document with given id.
 * Also deletes associated categories.
 * @param user
 * @param section_id
 * @returns A promise with the delete result
 */
export const deleteSection = async (user: MaskedUser, section_id: string) => {
  if (!section_id) return;
  const { user_id } = user;

  // Delete categories for this section
  await pool.query(
    `DELETE FROM categories WHERE user_id = $1 AND section_id = $2`,
    [user_id, section_id]
  );

  // Delete section
  const result = await pool.query(
    `DELETE FROM sections WHERE user_id = $1 AND section_id = $2`,
    [user_id, section_id]
  );

  return { deleted: result.rowCount };
};

/**
 * Creates a document that represents a category.
 * Note: Budget > Section > Category
 * @param user
 * @param section_id parent section's id
 * @returns A promise with the created category id
 */
export const createCategory = async (user: MaskedUser, section_id: string) => {
  const { user_id } = user;
  const updated = new Date().toISOString();

  const category = {
    name: "Unnamed",
    section_id,
    capacities: [{ capacity_id: getRandomId(), month: 0 }],
    roll_over: false,
  };

  const result = await pool.query(
    `INSERT INTO categories (user_id, section_id, name, capacities, roll_over, updated)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING category_id`,
    [user_id, section_id, category.name, JSON.stringify(category.capacities), category.roll_over, updated]
  );

  return { _id: result.rows[0].category_id };
};

export type PartialCategory = { category_id: string } & Partial<JSONCategory>;

/**
 * Updates category document with given object.
 * @param user
 * @param category
 * @returns A promise with the update result
 */
export const updateCategory = async (user: MaskedUser, category: PartialCategory) => {
  const { user_id } = user;
  const { category_id, name, section_id, capacities, roll_over, roll_over_start_date } = category;
  const updated = new Date().toISOString();

  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(name);
  }
  if (section_id !== undefined) {
    updates.push(`section_id = $${paramIndex++}`);
    values.push(section_id);
  }
  if (capacities !== undefined) {
    updates.push(`capacities = $${paramIndex++}`);
    values.push(JSON.stringify(capacities));
  }
  if (roll_over !== undefined) {
    updates.push(`roll_over = $${paramIndex++}`);
    values.push(roll_over);
  }
  if (roll_over_start_date !== undefined) {
    updates.push(`roll_over_start_date = $${paramIndex++}`);
    values.push(roll_over_start_date);
  }

  updates.push(`updated = $${paramIndex++}`);
  values.push(updated);

  values.push(category_id);
  values.push(user_id);

  const result = await pool.query(
    `UPDATE categories SET ${updates.join(", ")} 
     WHERE category_id = $${paramIndex++} AND user_id = $${paramIndex}`,
    values
  );

  return result;
};

/**
 * Deletes category document with given id.
 * @param user
 * @param category_id
 * @returns A promise with the delete result
 */
export const deleteCategory = async (user: MaskedUser, category_id: string) => {
  if (!category_id) return;
  const { user_id } = user;

  const result = await pool.query(
    `DELETE FROM categories WHERE user_id = $1 AND category_id = $2`,
    [user_id, category_id]
  );

  return { deleted: result.rowCount };
};

/**
 * Searches for budgets associated with given user.
 * @param user
 * @returns A promise to be an object with budgets, sections, and categories arrays
 */
export const searchBudgets = async (user: MaskedUser) => {
  const { user_id } = user;

  const budgetsResult = await pool.query<{
    budget_id: string;
    name: string;
    iso_currency_code: string;
    capacities: any;
    roll_over: boolean;
    roll_over_start_date: Date | null;
  }>(
    `SELECT budget_id, name, iso_currency_code, capacities, roll_over, roll_over_start_date 
     FROM budgets WHERE user_id = $1`,
    [user_id]
  );

  const sectionsResult = await pool.query<{
    section_id: string;
    budget_id: string;
    name: string;
    capacities: any;
    roll_over: boolean;
    roll_over_start_date: Date | null;
  }>(
    `SELECT section_id, budget_id, name, capacities, roll_over, roll_over_start_date 
     FROM sections WHERE user_id = $1`,
    [user_id]
  );

  const categoriesResult = await pool.query<{
    category_id: string;
    section_id: string;
    name: string;
    capacities: any;
    roll_over: boolean;
    roll_over_start_date: Date | null;
  }>(
    `SELECT category_id, section_id, name, capacities, roll_over, roll_over_start_date 
     FROM categories WHERE user_id = $1`,
    [user_id]
  );

  const budgets: JSONBudget[] = budgetsResult.rows.map((row) => ({
    budget_id: row.budget_id,
    name: row.name,
    iso_currency_code: row.iso_currency_code,
    capacities: row.capacities,
    roll_over: row.roll_over,
    roll_over_start_date: row.roll_over_start_date || undefined,
  }));

  const sections: JSONSection[] = sectionsResult.rows.map((row) => ({
    section_id: row.section_id,
    budget_id: row.budget_id,
    name: row.name,
    capacities: row.capacities,
    roll_over: row.roll_over,
    roll_over_start_date: row.roll_over_start_date || undefined,
  }));

  const categories: JSONCategory[] = categoriesResult.rows.map((row) => ({
    category_id: row.category_id,
    section_id: row.section_id,
    name: row.name,
    capacities: row.capacities,
    roll_over: row.roll_over,
    roll_over_start_date: row.roll_over_start_date || undefined,
  }));

  return { budgets, sections, categories };
};
