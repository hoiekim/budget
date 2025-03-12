import { Route, createChart } from "server";

export type NewChartGetResponse = { chart_id: string };

export const getNewChartRoute = new Route<NewChartGetResponse>(
  "GET",
  "/new-chart",
  async (req, res) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const response = await createChart(user);
    return { status: "success", body: { chart_id: response._id } };
  }
);
