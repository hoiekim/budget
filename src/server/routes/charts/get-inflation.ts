import { JSONAverageInflation } from "common";
import { Route, getAverageInflation } from "server";

/** `null` until the scheduled refresh has stored at least a year of CPI history. */
export type InflationGetResponse = JSONAverageInflation | null;

/**
 * Average annual inflation for the projection chart's auto goal
 * configuration. Reads `cpi_snapshots` only — BLS is reached solely by the
 * scheduled refresh, so no client request spends the API's daily quota.
 */
export const getInflationRoute = new Route<InflationGetResponse>(
  "GET",
  "/inflation",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return { status: "failed", message: "Request user is not authenticated." };
    }

    const body = await getAverageInflation();
    return { status: "success", body };
  },
);
