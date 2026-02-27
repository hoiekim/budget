import { Route, updateChart, requireBodyObject, requireStringField, validationError } from "server";
import { logger } from "server/lib/logger";

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

  const { chart_id, ...data } = body;

  try {
    await updateChart(user, chart_id as string, data);
    return { status: "success" };
  } catch (error: any) {
    logger.error("Failed to update chart", { chartId: chart_id }, error);
    throw new Error(error);
  }
});
