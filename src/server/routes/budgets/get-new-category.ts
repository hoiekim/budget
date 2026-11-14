import { JSONCategory } from "common";
import { createCategory, makeGetNewEntityRoute } from "server";

export type NewCategoryGetResponse = { category: JSONCategory };

export const getNewCategoryRoute = makeGetNewEntityRoute("/new-category", createCategory, {
  parentField: "section_id",
  bodyKey: "category",
  failureMessage: "Failed to create category.",
});
