import { Route, deleteChart } from "server";

export const deleteChartRoute = new Route("DELETE", "/chart", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const chart_id = req.query.id as string;

  if (!chart_id) {
    return {
      status: "failed",
      message: "id is required but not provided.",
    };
  }

  await deleteChart(user, chart_id);

  return { status: "success" };
});
