import { searchBudgets, Route } from "server";
import { JSONBudget, JSONSection, JSONCategory } from "common";

export interface BudgetsGetResponse {
  budgets: JSONBudget[];
  sections: JSONSection[];
  categories: JSONCategory[];
}

export const getBudgetsRoute = new Route<BudgetsGetResponse>(
  "GET",
  "/budgets",
  async (req, res) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        info: "Request user is not authenticated.",
      };
    }

    const data = await searchBudgets(user);

    return { status: "success", data };
  }
);
