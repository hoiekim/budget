import {
  Route,
  updateCategory,
  requireBodyObject,
  requireStringField,
  validateFields,
  validationError,
} from "server";
import type { FieldSpec } from "server";
import { logger } from "server/lib/logger";

/**
 * Typed fields `updateCategory` writes (`models/category.ts`).
 */
const CATEGORY_BODY_SPEC: FieldSpec[] = [
  { path: "category_id", type: "uuid" },
  { path: "name", type: "string", nullable: true },
  { path: "roll_over", type: "boolean", nullable: true },
  { path: "roll_over_start_date", type: "date", nullable: true },
  { path: "capacities", type: "array" },
];

export const postCategoryRoute = new Route("POST", "/category", async (req) => {
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
  const idResult = requireStringField(body, "category_id");
  if (!idResult.success) return validationError(idResult.error!);

  const fieldsResult = validateFields(body, CATEGORY_BODY_SPEC);
  if (!fieldsResult.success) return validationError(fieldsResult.error!);

  const { category_id, ...data } = body;

  try {
    await updateCategory(user, category_id as string, data);
    return { status: "success" };
  } catch (error: unknown) {
    logger.error("Failed to update category", { categoryId: category_id }, error);
    throw error instanceof Error ? error : new Error(String(error));
  }
});
