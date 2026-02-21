import { plaid, Route, optionalQueryString, validationError } from "server";

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

    const accessTokenResult = optionalQueryString(req, "access_token");
    if (!accessTokenResult.success) return validationError(accessTokenResult.error!);

    const response = await plaid.getLinkToken(user, accessTokenResult.data);
    if (!response) throw new Error("Server failed to get link token.");

    return {
      status: "success",
      body: response.link_token,
    };
  }
);
