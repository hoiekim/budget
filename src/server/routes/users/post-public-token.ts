import { randomUUID } from "crypto";
import {
  plaidClient,
  simpleFinClient,
  Route,
  pushLocalItem,
  upsertItems,
  MaskedUser,
} from "server";
import { Item, ItemProvider, ItemStatus } from "common";

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

    const { provider } = req.query;

    if (provider === ItemProvider.SIMPLE_FIN) {
      const { public_token } = req.body;
      if (typeof public_token !== "string") {
        return {
          status: "failed",
          message: "Request body has wrong type of public_token",
        };
      }

      const item = await exchangeSimpleFinToken(public_token);
      await upsertItems(user, [item]);
      if (user.username === "admin") pushLocalItem(item);
      return { status: "success", body: { item } };
    } else if (provider === ItemProvider.PLAID) {
      const { public_token, institution_id } = req.body;
      if (typeof public_token !== "string" || typeof institution_id !== "string") {
        return {
          status: "failed",
          message: "Request body has wrong type of public_token",
        };
      }

      const item = await exchangePlaidToken(user, public_token, institution_id);
      await upsertItems(user, [item]);
      if (user.username === "admin") pushLocalItem(item);
      return { status: "success", body: { item } };
    } else {
      return {
        status: "failed",
        message: "Request has wrong type of provider",
      };
    }
  }
);

const exchangePlaidToken = async (
  user: MaskedUser,
  public_token: string,
  institution_id: string
) => {
  const { access_token, item_id } = await plaidClient.exchangePublicToken(user, public_token);
  return new Item({
    item_id,
    access_token,
    institution_id,
    status: ItemStatus.OK,
    provider: ItemProvider.PLAID,
  });
};

const exchangeSimpleFinToken = async (setupToken: string) => {
  const accessUrl = await simpleFinClient.exchangeSetupToken(setupToken);
  return new Item({
    item_id: randomUUID(),
    access_token: accessUrl,
    institution_id: "unknown",
    status: ItemStatus.OK,
    provider: ItemProvider.SIMPLE_FIN,
  });
};
