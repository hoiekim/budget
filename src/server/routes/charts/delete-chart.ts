import { Route, deleteChart, requireQueryString, validationError } from "server";

export const deleteChartRoute = new Route("DELETE", "/chart", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const idResult = requireQueryString(req, "id");
  if (!idResult.success) {
    return validationError(idResult.error!);
  }
  const chart_id = idResult.data!;

  await deleteChart(user, chart_id);

  return { status: "success" };
});
