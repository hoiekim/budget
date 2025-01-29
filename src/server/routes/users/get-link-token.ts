import { plaid, Route } from "server";

export type LinkTokenGetResponse = string;

export const getLinkTokenRoute = new Route<LinkTokenGetResponse>(
  "GET",
  "/link-token",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const { access_token } = req.query;

    if (typeof access_token !== "string" && typeof access_token !== "undefined") {
      return {
        status: "failed",
        message: "access_token value must be string.",
      };
    }

    const response = await plaid.getLinkToken(user, access_token);
    if (!response) throw new Error("Server failed to get link token.");

    return {
      status: "success",
      body: response.link_token,
    };
  }
);
