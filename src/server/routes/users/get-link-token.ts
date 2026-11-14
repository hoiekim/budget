import { plaid, Route, optionalQueryString, validationError, getItem } from "server";

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

    const itemIdResult = optionalQueryString(req, "item_id");
    if (!itemIdResult.success) return validationError(itemIdResult.error!);

    // The browser names the item; the server resolves the stored credential
    // itself. The lookup is scoped to the requesting user, so a caller can
    // never mint an update-mode link token for another user's item.
    let accessToken: string | undefined;
    if (itemIdResult.data) {
      const item = await getItem(user, itemIdResult.data);
      if (!item) {
        return {
          status: "failed",
          message: "Item not found.",
        };
      }
      accessToken = item.access_token;
    }

    if (!plaid.isPlaidConfigured) {
      return {
        status: "failed",
        message: "Plaid integration is not configured on this server.",
      };
    }

    const response = await plaid.getLinkToken(user, accessToken);
    if (!response) throw new Error("Server failed to get link token.");

    return {
      status: "success",
      body: response.link_token,
    };
  }
);
