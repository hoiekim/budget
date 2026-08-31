import {
  Route,
  updateBudget,
  requireBodyObject,
  requireStringField,
  validateFields,
  validationError,
} from "server";
import type { FieldSpec } from "server";
import { logger } from "server/lib/logger";

/**
 * Typed fields `BudgetModel.fromJSON` copies into a row (`models/budget.ts`).
 * `name` is not nullable here even though the column is: the client's
 * `BudgetFamily.name` is a plain `string` and `useBudgetCategorySelect` calls
 * `.trim()` on it unguarded, so a null name renders every transaction row into
 * a TypeError.
 */
const BUDGET_BODY_SPEC: FieldSpec[] = [
  { path: "budget_id", type: "uuid" },
  { path: "name", type: "string" },
  { path: "iso_currency_code", type: "string", nullable: true },
  { path: "roll_over", type: "boolean", nullable: true },
  { path: "roll_over_start_date", type: "date", nullable: true },
  { path: "capacities", type: "array" },
];

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

  const fieldsResult = validateFields(body, BUDGET_BODY_SPEC);
  if (!fieldsResult.success) return validationError(fieldsResult.error!);

  const { budget_id, ...data } = body;

  if (typeof data.name === "string" && data.name.trim() === "") {
    return { status: "failed", message: "Budget name cannot be empty." };
  }

  try {
    await updateBudget(user, budget_id as string, data);
    return { status: "success" };
  } catch (error: unknown) {
    logger.error("Failed to update budget", { budgetId: budget_id }, error);
    throw error instanceof Error ? error : new Error(String(error));
  }
});
