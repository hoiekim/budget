import { Route, updateBudget, requireBodyObject, requireStringField, validationError } from "server";
import { logger } from "server/lib/logger";

export const postBudgetRoute = new Route("POST", "/budget", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const bodyResult = requireBodyObject(req);
  if (!bodyResult.success) return validationError(bodyResult.error!);

  const body = bodyResult.data as Record<string, unknown>;
  const idResult = requireStringField(body, "budget_id");
  if (!idResult.success) return validationError(idResult.error!);

  const { budget_id, ...data } = body;

  try {
    await updateBudget(user, budget_id as string, data);
    return { status: "success" };
  } catch (error: any) {
    logger.error("Failed to update budget", { budgetId: budget_id }, error);
    throw new Error(error);
  }
});
