import { Route, getSecuritiesForUser } from "server";
import { JSONSecurity } from "common";

export type SecuritiesGetResponse = JSONSecurity[];

export const getSecuritiesRoute = new Route<SecuritiesGetResponse>(
  "GET",
  "/securities",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return { status: "failed", message: "Request user is not authenticated." };
    }

    const securities = await getSecuritiesForUser(user);
    return { status: "success", body: securities };
  },
);
