import { exchangePublicToken, Route, pushLocalItem, upsertItems } from "server";
import { Item } from "common";

export interface PbulicTokenPostResponse {
  item: Item;
}

export const postPublicTokenRoute = new Route<PbulicTokenPostResponse>(
  "POST",
  "/public-token",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const { public_token, institution_id } = req.body;
    if (typeof public_token !== "string" || typeof institution_id !== "string") {
      return {
        status: "failed",
        message: "Request body has wrong type of public_token",
      };
    }

    const { access_token, item_id } = await exchangePublicToken(user, public_token);
    const item = new Item({ item_id, access_token, institution_id });

    await upsertItems(user, [item]);

    if (user.username === "admin") pushLocalItem(item);

    return { status: "success", body: { item } };
  }
);
