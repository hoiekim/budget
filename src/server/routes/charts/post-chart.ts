import {
  Route,
  updateChart,
  requireBodyObject,
  requireStringField,
  validateFields,
  validationError,
} from "server";
import type { FieldSpec } from "server";
import { logger } from "server/lib/logger";

/**
 * Typed fields `ChartModel.fromJSON` copies into a row (`models/chart.ts`).
 * `configuration` is JSONB and the write side accepts a string or an object,
 * but the client always sends `JSON.stringify` output — pinned to the
 * client's shape so a raw object can't drift in unnoticed.
 */
const CHART_BODY_SPEC: FieldSpec[] = [
  { path: "chart_id", type: "uuid" },
  { path: "name", type: "string", nullable: true },
  { path: "type", type: "string", nullable: true },
  { path: "configuration", type: "string" },
];

export const postChartRoute = new Route("POST", "/chart", async (req) => {
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
  const idResult = requireStringField(body, "chart_id");
  if (!idResult.success) return validationError(idResult.error!);

  const fieldsResult = validateFields(body, CHART_BODY_SPEC);
  if (!fieldsResult.success) return validationError(fieldsResult.error!);

  const { chart_id, ...data } = body;

  try {
    await updateChart(user, chart_id as string, data);
    return { status: "success" };
  } catch (error: unknown) {
    logger.error("Failed to update chart", { chartId: chart_id }, error);
    throw error instanceof Error ? error : new Error(String(error));
  }
});
