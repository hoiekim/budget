import { Route, deleteBudget } from "server";

export const deleteBudgetRoute = new Route("DELETE", "/budget", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const budget_id = req.query.id as string;

  if (!budget_id) {
    return {
      status: "failed",
      info: "id is required but not provided.",
    };
  }

  await deleteBudget(user, budget_id);

  return { status: "success" };
});
