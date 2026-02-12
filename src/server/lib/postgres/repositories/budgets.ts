import { JSONBudget, JSONSection, JSONCategory } from "common";
import {
  MaskedUser,
  BudgetModel,
  SectionModel,
  CategoryModel,
  budgetsTable,
  sectionsTable,
  categoriesTable,
  BUDGET_ID,
  SECTION_ID,
  USER_ID,
} from "../models";

export const getBudgets = async (user: MaskedUser): Promise<JSONBudget[]> => {
  const models = await budgetsTable.query({ [USER_ID]: user.user_id });
  return models.map((m) => m.toJSON());
};

export const getBudget = async (
  user: MaskedUser,
  budget_id: string,
): Promise<JSONBudget | null> => {
  const model = await budgetsTable.queryOne({ [USER_ID]: user.user_id, [BUDGET_ID]: budget_id });
  return model?.toJSON() ?? null;
};

export const searchBudgets = async (
  user: MaskedUser,
  options: { budget_id?: string } = {},
): Promise<JSONBudget[]> => {
  const filters: Record<string, unknown> = { [USER_ID]: user.user_id };
  if (options.budget_id) filters[BUDGET_ID] = options.budget_id;
  const models = await budgetsTable.query(filters);
  return models.map((m) => m.toJSON());
};

export const createBudget = async (
  user: MaskedUser,
  data: Partial<JSONBudget>,
): Promise<JSONBudget | null> => {
  try {
    const row = BudgetModel.fromJSON(
      {
        name: data.name || "New Budget",
        iso_currency_code: data.iso_currency_code || "USD",
        roll_over: data.roll_over || false,
        roll_over_start_date: data.roll_over_start_date,
        capacities: data.capacities || [],
      },
      user.user_id,
    );
    const result = await budgetsTable.insert(row, ["*"]);
    if (!result) return null;
    const model = new BudgetModel(result);
    return model.toJSON();
  } catch (error) {
    console.error("Failed to create budget:", error);
    return null;
  }
};

export const updateBudget = async (
  user: MaskedUser,
  budget_id: string,
  data: Partial<JSONBudget>,
): Promise<boolean> => {
  const updates: Record<string, unknown> = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.iso_currency_code !== undefined) updates.iso_currency_code = data.iso_currency_code;
  if (data.roll_over !== undefined) updates.roll_over = data.roll_over;
  if (data.roll_over_start_date !== undefined)
    updates.roll_over_start_date = data.roll_over_start_date;
  if (data.capacities !== undefined) updates.capacities = JSON.stringify(data.capacities);

  if (Object.keys(updates).length === 0) return false;
  const model = await budgetsTable.update(budget_id, updates);
  return model !== null;
};

export const deleteBudget = async (user: MaskedUser, budget_id: string): Promise<boolean> => {
  const sections = await sectionsTable.query({ [USER_ID]: user.user_id, [BUDGET_ID]: budget_id });
  const sectionIds = sections.map((s) => s.section_id);

  if (sectionIds.length > 0) {
    for (const sid of sectionIds) {
      await categoriesTable.softDelete(sid);
    }
  }

  for (const sid of sectionIds) {
    await sectionsTable.softDelete(sid);
  }

  return await budgetsTable.softDelete(budget_id);
};

export const deleteBudgets = async (
  user: MaskedUser,
  budget_ids: string[],
): Promise<{ deleted: number }> => {
  if (!budget_ids.length) return { deleted: 0 };
  let deleted = 0;
  for (const id of budget_ids) {
    if (await deleteBudget(user, id)) deleted++;
  }
  return { deleted };
};

export const getSections = async (user: MaskedUser, budget_id?: string): Promise<JSONSection[]> => {
  const filters: Record<string, unknown> = { [USER_ID]: user.user_id };
  if (budget_id) filters[BUDGET_ID] = budget_id;
  const models = await sectionsTable.query(filters);
  return models.map((m) => m.toJSON());
};

export const createSection = async (
  user: MaskedUser,
  data: Partial<JSONSection>,
): Promise<JSONSection | null> => {
  try {
    const row = SectionModel.fromJSON(
      {
        budget_id: data.budget_id,
        name: data.name || "New Section",
        roll_over: data.roll_over || false,
        roll_over_start_date: data.roll_over_start_date,
        capacities: data.capacities || [],
      },
      user.user_id,
    );
    const result = await sectionsTable.insert(row, ["*"]);
    if (!result) return null;
    const model = new SectionModel(result);
    return model.toJSON();
  } catch (error) {
    console.error("Failed to create section:", error);
    return null;
  }
};

export const updateSection = async (
  user: MaskedUser,
  section_id: string,
  data: Partial<JSONSection>,
): Promise<boolean> => {
  const updates: Record<string, unknown> = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.roll_over !== undefined) updates.roll_over = data.roll_over;
  if (data.roll_over_start_date !== undefined)
    updates.roll_over_start_date = data.roll_over_start_date;
  if (data.capacities !== undefined) updates.capacities = JSON.stringify(data.capacities);

  if (Object.keys(updates).length === 0) return false;
  const model = await sectionsTable.update(section_id, updates);
  return model !== null;
};

export const deleteSection = async (user: MaskedUser, section_id: string): Promise<boolean> => {
  const categories = await categoriesTable.query({
    [USER_ID]: user.user_id,
    [SECTION_ID]: section_id,
  });
  for (const cat of categories) {
    await categoriesTable.softDelete(cat.category_id);
  }
  return await sectionsTable.softDelete(section_id);
};

export const deleteSections = async (
  user: MaskedUser,
  section_ids: string[],
): Promise<{ deleted: number }> => {
  if (!section_ids.length) return { deleted: 0 };
  let deleted = 0;
  for (const id of section_ids) {
    if (await deleteSection(user, id)) deleted++;
  }
  return { deleted };
};

export const getCategories = async (
  user: MaskedUser,
  section_id?: string,
): Promise<JSONCategory[]> => {
  const filters: Record<string, unknown> = { [USER_ID]: user.user_id };
  if (section_id) filters[SECTION_ID] = section_id;
  const models = await categoriesTable.query(filters);
  return models.map((m) => m.toJSON());
};

export const createCategory = async (
  user: MaskedUser,
  data: Partial<JSONCategory>,
): Promise<JSONCategory | null> => {
  try {
    const row = CategoryModel.fromJSON(
      {
        section_id: data.section_id,
        name: data.name || "New Category",
        roll_over: data.roll_over || false,
        roll_over_start_date: data.roll_over_start_date,
        capacities: data.capacities || [],
      },
      user.user_id,
    );
    const result = await categoriesTable.insert(row, ["*"]);
    if (!result) return null;
    const model = new CategoryModel(result);
    return model.toJSON();
  } catch (error) {
    console.error("Failed to create category:", error);
    return null;
  }
};

export const updateCategory = async (
  user: MaskedUser,
  category_id: string,
  data: Partial<JSONCategory>,
): Promise<boolean> => {
  const updates: Record<string, unknown> = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.roll_over !== undefined) updates.roll_over = data.roll_over;
  if (data.roll_over_start_date !== undefined)
    updates.roll_over_start_date = data.roll_over_start_date;
  if (data.capacities !== undefined) updates.capacities = JSON.stringify(data.capacities);

  if (Object.keys(updates).length === 0) return false;
  const model = await categoriesTable.update(category_id, updates);
  return model !== null;
};

export const deleteCategory = async (user: MaskedUser, category_id: string): Promise<boolean> => {
  return await categoriesTable.softDelete(category_id);
};

export const deleteCategories = async (
  user: MaskedUser,
  category_ids: string[],
): Promise<{ deleted: number }> => {
  if (!category_ids.length) return { deleted: 0 };
  let deleted = 0;
  for (const id of category_ids) {
    if (await categoriesTable.softDelete(id)) deleted++;
  }
  return { deleted };
};
