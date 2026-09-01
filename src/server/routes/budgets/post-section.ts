import {
  Route,
  updateSection,
  requireBodyObject,
  requireStringField,
  validateFields,
  validationError,
} from "server";
import type { FieldSpec } from "server";
import { logger } from "server/lib/logger";

/**
 * Typed fields `updateSection` writes (`models/section.ts`).
 */
const SECTION_BODY_SPEC: FieldSpec[] = [
  { path: "section_id", type: "uuid" },
  { path: "name", type: "string", nullable: true },
  { path: "roll_over", type: "boolean", nullable: true },
  { path: "roll_over_start_date", type: "date", nullable: true },
  { path: "capacities", type: "array" },
];

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

  const fieldsResult = validateFields(body, SECTION_BODY_SPEC);
  if (!fieldsResult.success) return validationError(fieldsResult.error!);

  const { section_id, ...data } = body;

  try {
    await updateSection(user, section_id as string, data);
    return { status: "success" };
  } catch (error: unknown) {
    logger.error("Failed to update section", { sectionId: section_id }, error);
    throw error instanceof Error ? error : new Error(String(error));
  }
});
