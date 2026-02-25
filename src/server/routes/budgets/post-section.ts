import { Route, updateSection, requireBodyObject, requireStringField, validationError } from "server";
import { logger } from "server/lib/logger";

export const postSectionRoute = new Route("POST", "/section", async (req) => {
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
  const idResult = requireStringField(body, "section_id");
  if (!idResult.success) return validationError(idResult.error!);

  const { section_id, ...data } = body;

  try {
    await updateSection(user, section_id as string, data);
    return { status: "success" };
  } catch (error: any) {
    logger.error("Failed to update section", { sectionId: section_id }, error);
    throw new Error(error);
  }
});
