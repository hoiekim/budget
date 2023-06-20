import { Route, createBudget } from "server";

export type NewBudgetGetResponse = { budget_id: string };

export const getNewBudgetRoute = new Route<NewBudgetGetResponse>(
  "GET",
  "/new-budget",
  async (req, res) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const response = await createBudget(user);
    return { status: "success", body: { budget_id: response._id } };
  }
);
