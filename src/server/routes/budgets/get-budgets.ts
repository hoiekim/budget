import { searchBudgets, getSections, getCategories, Route } from "server";
import { JSONBudget, JSONSection, JSONCategory } from "common";

export interface BudgetsGetResponse {
  budgets: JSONBudget[];
  sections: JSONSection[];
  categories: JSONCategory[];
}

export const getBudgetsRoute = new Route<BudgetsGetResponse>(
  "GET",
  "/budgets",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const [budgets, sections, categories] = await Promise.all([
      searchBudgets(user),
      getSections(user),
      getCategories(user),
    ]);

    return { status: "success", body: { budgets, sections, categories } };
  }
);
