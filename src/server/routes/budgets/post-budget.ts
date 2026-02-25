import { Route, updateBudget, requireBodyObject, requireStringField, validationError } from "server";

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
  } catch (error: unknown) {
    console.error(`Failed to update a budget: ${budget_id}`);
    throw error instanceof Error ? error : new Error(String(error));
  }
});
