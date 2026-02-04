import { Route, updateBudget } from "server";

export const postBudgetRoute = new Route("POST", "/budget", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  if (!req.body || !Object.keys(req.body).length) {
    return {
      status: "failed",
      message: "Request body is required but not provided.",
    };
  }

  const { budget_id, ...data } = req.body;
  if (!budget_id) {
    return {
      status: "failed",
      message: "budget_id is required but not provided.",
    };
  }

  try {
    await updateBudget(user, budget_id, data);
    return { status: "success" };
  } catch (error: any) {
    console.error(`Failed to update a budget: ${budget_id}`);
    throw new Error(error);
  }
});
