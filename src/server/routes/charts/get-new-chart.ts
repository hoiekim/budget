import { Route, createChart } from "server";

export type NewChartGetResponse = { chart_id: string };

export const getNewChartRoute = new Route<NewChartGetResponse>(
  "GET",
  "/new-chart",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const response = await createChart(user, {});
    if (!response) {
      return { status: "failed", message: "Failed to create chart." };
    }
    return { status: "success", body: { chart_id: response.chart_id } };
  }
);
