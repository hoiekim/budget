import { searchBudgets, Route } from "server";
import { Budget, Section, Category } from "common";

export interface BudgetsGetResponse {
  budgets: Budget[];
  sections: Section[];
  categories: Category[];
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
