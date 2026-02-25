import { Route, updateCategory, requireBodyObject, requireStringField, validationError } from "server";
import { logger } from "server/lib/logger";

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

  const { category_id, ...data } = body;

  try {
    await updateCategory(user, category_id as string, data);
    return { status: "success" };
  } catch (error: any) {
    logger.error("Failed to update category", { categoryId: category_id }, error);
    throw new Error(error);
  }
});
