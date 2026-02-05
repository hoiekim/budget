import { Route, createBudget } from "server";

export type NewBudgetGetResponse = { budget_id: string };

export const getNewBudgetRoute = new Route<NewBudgetGetResponse>(
  "GET",
  "/new-budget",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const response = await createBudget(user, {});
    if (!response) {
      return { status: "failed", message: "Failed to create budget." };
    }
    return { status: "success", body: { budget_id: response.budget_id } };
  }
);
