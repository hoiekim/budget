import {
  MaskedUser,
  getUpdateBudgetScript,
  getUpdateSectionScript,
  getUpdateCategoryScript,
} from "server";
import { elasticsearchClient, index } from "./client";

export type Interval = "year" | "month" | "week" | "day";

export type Capacity = {
  [key in Interval]: number;
};

export interface Budget {
  budget_id: string;
  name: string;
  capacities: Capacity[];
  iso_currency_code: string;
  roll_over: boolean;
  roll_over_start_date?: string;
}

/**
 * Creates a document that represents a budget.
 * Note: Budget > Section > Category
 * @param user
 * @param budget
 * @returns A promise to be an Elasticsearch response object
 */
export const createBudget = async (user: MaskedUser) => {
  const { user_id } = user;
  const response = await elasticsearchClient.index({
    index,
    document: {
      type: "budget",
      user: { user_id },
      budget: {
        name: "",
        capacities: [{ year: 0, month: 0, week: 0, day: 0 }],
        iso_currency_code: "USD",
      },
    },
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
  return elasticsearchClient.update({ index, id: budget_id, script });
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

  const section_ids = await elasticsearchClient
    .search({
      index,
      query: {
        term: { "section.budget_id": budget_id },
      },
    })
    .then((r) => {
      return r.hits.hits.map((e) => e._id);
    });

  const response = await elasticsearchClient.deleteByQuery({
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

export interface Section {
  section_id: string;
  budget_id: string;
  name: string;
  capacities: Capacity[];
  roll_over: boolean;
  roll_over_start_date?: string;
}

/**
 * Creates a document that represents a section.
 * Note: Budget > Section > Category
 * @param user
 * @param budget_id parent budget's id
 * @returns A promise to be an Elasticsearch response object
 */
export const createSection = async (user: MaskedUser, budget_id: string) => {
  const { user_id } = user;
  const response = await elasticsearchClient.index({
    index,
    document: {
      type: "section",
      user: { user_id },
      section: {
        budget_id,
        name: "",
        capacities: [{ year: 0, month: 0, week: 0, day: 0 }],
      },
    },
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
  return elasticsearchClient.update({ index, id: section_id, script });
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

  const response = await elasticsearchClient.deleteByQuery({
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
                    filter: [
                      { term: { type: "section" } },
                      { term: { _id: section_id } },
                    ],
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

export interface Category {
  category_id: string;
  section_id: string;
  name: string;
  capacities: Capacity[];
  roll_over: boolean;
  roll_over_start_date?: string;
}

/**
 * Creates a document that represents a category.
 * Note: Budget > Section > Category
 * @param user
 * @param section_id parent section's id
 * @returns A promise to be an Elasticsearch response object
 */
export const createCategory = async (user: MaskedUser, section_id: string) => {
  const { user_id } = user;
  const response = await elasticsearchClient.index({
    index,
    document: {
      type: "category",
      user: { user_id },
      category: {
        section_id,
        name: "",
        capacities: [{ year: 0, month: 0, week: 0, day: 0 }],
      },
    },
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
  return elasticsearchClient.update({ index, id: category_id, script });
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

  const response = await elasticsearchClient.deleteByQuery({
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
  const response = await elasticsearchClient.search<{
    type: string;
    budget?: Budget;
    section?: Section;
    category?: Category;
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

  const budgets: Budget[] = [];
  const sections: Section[] = [];
  const categories: Category[] = [];

  response.hits.hits.forEach((e) => {
    const source = e._source;
    const id = e._id;
    if (!source) return;
    if (source.type === "budget") {
      source.budget && budgets.push({ ...source.budget, budget_id: id });
    } else if (source.type === "section") {
      source.section && sections.push({ ...source.section, section_id: id });
    } else if (source.type === "category") {
      source.category && categories.push({ ...source.category, category_id: id });
    }
  });

  return { budgets, sections, categories };
};
