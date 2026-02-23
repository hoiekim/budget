import { Route, searchCharts } from "server";
import { JSONChart } from "common";

export type ChartsGetResponse = JSONChart[];

export const getChartsRoute = new Route<ChartsGetResponse>("GET", "/charts", async (req, _res) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const body = await searchCharts(user);

  return { status: "success", body };
});
