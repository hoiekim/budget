import { Client } from "@elastic/elasticsearch";
import { MaskedUser } from "server";
import { index } from "./client";

const client = new Client({ node: process.env.ELASTICSEARCH_HOST });

export type Interval = "year" | "month" | "week" | "day";

export interface Budget {
  budget_id: string;
  name: string;
  interval: Interval;
  capacity: number;
}

/**
 * Creates a document that represents a budget.
 * Note: Budget > Section > Category
 * @param user
 * @param budget
 * @returns A promise to be an Elasticsearch result object
 */
export const createBudget = async (user: MaskedUser) => {
  const { user_id } = user;
  const response = await client.index({
    index,
    body: { type: "budget", user: { user_id } },
  });

  return response;
};

/**
 * Updates budget document with given object.
 * @param budget
 * @returns A promise to be an Elasticsearch result object
 */
export const updateBudget = async (
  budget: Partial<Budget> & {
    budget_id: string;
  }
) => {
  const { budget_id } = budget;

  const response = await client.update({
    index,
    id: budget_id,
    doc: { budget: { ...budget, budget_id: undefined } },
  });

  return response;
};

export interface Section {
  section_id: string;
  budget_id: string;
  name: string;
  capacity: number;
}

/**
 * Creates a document that represents a section.
 * Note: Budget > Section > Category
 * @param user
 * @param section
 * @returns A promise to be an Elasticsearch result object
 */
export const createSection = async (user: MaskedUser) => {
  const { user_id } = user;
  const response = await client.index({
    index,
    body: { type: "section", user: { user_id } },
  });

  return response;
};

/**
 * Updates section document with given object.
 * @param section
 * @returns A promise to be an Elasticsearch result object
 */
export const updateSection = async (
  section: Partial<Section> & {
    section_id: string;
  }
) => {
  const { section_id } = section;

  const response = await client.update({
    index,
    id: section_id,
    doc: { section: { ...section, section_id: undefined } },
  });

  return response;
};

export interface Category {
  category_id: string;
  section_id: string;
  name: string;
  capacity: number;
}

/**
 * Creates a document that represents a category.
 * Note: Budget > Section > Category
 * @param user
 * @param category
 * @returns A promise to be an Elasticsearch result object
 */
export const createCategory = async (user: MaskedUser) => {
  const { user_id } = user;
  const response = await client.index({
    index,
    body: { type: "category", user: { user_id } },
  });

  return response;
};

/**
 * Updates category document with given object.
 * @param category
 * @returns A promise to be an Elasticsearch result object
 */
export const updateCategory = async (
  category: Partial<Category> & {
    category_id: string;
  }
) => {
  const { category_id } = category;

  const response = await client.update({
    index,
    id: category_id,
    doc: { category: { ...category, category_id: undefined } },
  });

  return response;
};

export interface Budgets {
  budgets: Budget[];
  sections: Section[];
  categories: Category[];
}

/**
 * Searches for accounts associated with given user.
 * @param user
 * @returns A promise to be an array of Account objects
 */
export const searchBudgets = async (user: MaskedUser): Promise<Budgets> => {
  const response = await client.search<{
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
