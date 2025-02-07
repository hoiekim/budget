import {
  MaskedUser,
  getUpdateBudgetScript,
  getUpdateSectionScript,
  getUpdateCategoryScript,
} from "server";
import { Budget, Section, Category, JSONBudget, JSONSection, JSONCategory } from "common";
import { client } from "./client";
import { index } from ".";

/**
 * Creates a document that represents a budget.
 * Note: Budget > Section > Category
 * @param user
 * @param budget
 * @returns A promise to be an Elasticsearch response object
 */
export const createBudget = async (user: MaskedUser) => {
  const { user_id } = user;

  type UnindexedBudget = Omit<Budget, "budget_id"> & { budget_id?: string };
  const budget: UnindexedBudget = new Budget();
  delete budget.budget_id;

  const response = await client.index({
    index,
    document: { type: "budget", user: { user_id }, budget },
  });

  return response;
};

export type PartialBudget = { budget_id: string } & Partial<Budget>;

/**
 * Updates budget document with given object.
 * @param user
 * @param budget
 * @returns A promise to be an Elasticsearch response object
 */
export const updateBudget = async (user: MaskedUser, budget: PartialBudget) => {
  const { budget_id } = budget;
  const script = getUpdateBudgetScript(user, budget);
  return client.update({ index, id: budget_id, script });
};

/**
 * Deletes budget document with given id.
 * @param user
 * @param budget_id
 * @returns A promise to be an Elasticsearch response object
 */
export const deleteBudget = async (user: MaskedUser, budget_id: string) => {
  if (!budget_id) return;

  const { user_id } = user;

  const section_ids = await client
    .search({
      index,
      query: {
        term: { "section.budget_id": budget_id },
      },
    })
    .then((r) => {
      return r.hits.hits.map((e) => e._id);
    });

  const response = await client.deleteByQuery({
    index,
    query: {
      bool: {
        filter: [
          { term: { "user.user_id": user_id } },
          {
            bool: {
              should: [
                {
                  bool: {
                    filter: [{ term: { type: "budget" } }, { term: { _id: budget_id } }],
                  },
                },
                { term: { "section.budget_id": budget_id } },
                ...section_ids.map((e) => ({ term: { "category.section_id": e } })),
              ],
            },
          },
        ],
      },
    },
  });

  return response;
};

/**
 * Creates a document that represents a section.
 * Note: Budget > Section > Category
 * @param user
 * @param budget_id parent budget's id
 * @returns A promise to be an Elasticsearch response object
 */
export const createSection = async (user: MaskedUser, budget_id: string) => {
  const { user_id } = user;

  type UnindexedSection = Omit<Section, "section_id"> & { section_id?: string };
  const section: UnindexedSection = new Section({ budget_id });
  delete section.section_id;

  const response = await client.index({
    index,
    document: { type: "section", user: { user_id }, section },
  });

  return response;
};

export type PartialSection = { section_id: string } & Partial<Section>;

/**
 * Updates section document with given object.
 * @param user
 * @param section
 * @returns A promise to be an Elasticsearch response object
 */
export const updateSection = async (user: MaskedUser, section: PartialSection) => {
  const { section_id } = section;
  const script = getUpdateSectionScript(user, section);
  return client.update({ index, id: section_id, script });
};

/**
 * Deletes section document with given id.
 * @param user
 * @param section_id
 * @returns A promise to be an Elasticsearch response object
 */
export const deleteSection = async (user: MaskedUser, section_id: string) => {
  if (!section_id) return;

  const { user_id } = user;

  const response = await client.deleteByQuery({
    index,
    query: {
      bool: {
        filter: [
          { term: { "user.user_id": user_id } },
          {
            bool: {
              should: [
                {
                  bool: {
                    filter: [{ term: { type: "section" } }, { term: { _id: section_id } }],
                  },
                },
                { term: { "category.section_id": section_id } },
              ],
            },
          },
        ],
      },
    },
  });

  return response;
};

/**
 * Creates a document that represents a category.
 * Note: Budget > Section > Category
 * @param user
 * @param section_id parent section's id
 * @returns A promise to be an Elasticsearch response object
 */
export const createCategory = async (user: MaskedUser, section_id: string) => {
  const { user_id } = user;

  type UnindexedCategory = Omit<Category, "category_id"> & { category_id?: string };
  const category: UnindexedCategory = new Category({ section_id });
  delete category.category_id;

  const response = await client.index({
    index,
    document: { type: "category", user: { user_id }, category },
  });

  return response;
};

export type PartialCategory = { category_id: string } & Partial<Category>;

/**
 * Updates category document with given object.
 * @param user
 * @param category
 * @returns A promise to be an Elasticsearch response object
 */
export const updateCategory = async (user: MaskedUser, category: PartialCategory) => {
  const { category_id } = category;
  const script = getUpdateCategoryScript(user, category);
  return client.update({ index, id: category_id, script });
};

/**
 * Deletes category document with given id.
 * @param user
 * @param category_id
 * @returns A promise to be an Elasticsearch response object
 */
export const deleteCategory = async (user: MaskedUser, category_id: string) => {
  if (!category_id) return;

  const { user_id } = user;

  const response = await client.deleteByQuery({
    index,
    query: {
      bool: {
        filter: [
          { term: { "user.user_id": user_id } },
          { term: { type: "category" } },
          { term: { _id: category_id } },
        ],
      },
    },
  });

  return response;
};

/**
 * Searches for accounts associated with given user.
 * @param user
 * @returns A promise to be an array of Account objects
 */
export const searchBudgets = async (user: MaskedUser) => {
  const response = await client.search<{
    type: string;
    budget?: JSONBudget;
    section?: JSONSection;
    category?: JSONCategory;
  }>({
    index,
    from: 0,
    size: 10000,
    query: {
      bool: {
        filter: [
          { term: { "user.user_id": user.user_id } },
          {
            bool: {
              should: [
                { term: { type: "budget" } },
                { term: { type: "section" } },
                { term: { type: "category" } },
              ],
            },
          },
        ],
      },
    },
  });

  const budgets: JSONBudget[] = [];
  const sections: JSONSection[] = [];
  const categories: JSONCategory[] = [];

  response.hits.hits.forEach((e) => {
    const source = e._source;
    const id = e._id;
    if (!source) return;
    if (source.type === "budget" && source.budget) {
      budgets.push({ ...source.budget, budget_id: id });
    }
    if (source.type === "section" && source.section) {
      sections.push({ ...source.section, section_id: id });
    }
    if (source.type === "category" && source.category) {
      categories.push({ ...source.category, category_id: id });
    }
  });

  return { budgets, sections, categories };
};
