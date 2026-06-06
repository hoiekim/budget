import { Route, deleteBudget, requireUuidQueryString, validationError } from "server";

export const deleteBudgetRoute = new Route("DELETE", "/budget", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const idResult = requireUuidQueryString(req, "id");
  if (!idResult.success) return validationError(idResult.error!);

  await deleteBudget(user, idResult.data!);

  return { status: "success" };
});
