import { JSONBudget } from "common";
import { Route, createBudget } from "server";

export type NewBudgetGetResponse = { budget: JSONBudget };

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
    return { status: "success", body: { budget: response } };
  }
);
