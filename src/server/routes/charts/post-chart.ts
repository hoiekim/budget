import { Route, updateChart } from "server";

export const postChartRoute = new Route("POST", "/chart", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  if (!req.body || !Object.keys(req.body).length) {
    return {
      status: "failed",
      message: "Request body is required but not provided.",
    };
  }

  if (!req.body.chart_id) {
    return {
      status: "failed",
      message: "chart_id is required but not provided.",
    };
  }

  try {
    await updateChart(user, req.body);
    return { status: "success" };
  } catch (error: any) {
    console.error(`Failed to update a chart_id: ${req.body.chart_id}`);
    throw new Error(error);
  }
});
