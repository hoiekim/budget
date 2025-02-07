import { randomUUID } from "crypto";
import {
  plaid,
  simpleFin,
  Route,
  pushLocalItem,
  upsertItems,
  MaskedUser,
  syncSimpleFinData,
  syncPlaidAccounts,
  syncPlaidTransactions,
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
      if (item.access_token === "Forbidden") {
        return { status: "failed", message: "Invalid token" };
      }

      await upsertItems(user, [item]);
      if (user.username === "admin") pushLocalItem(item);

      await syncSimpleFinData(item.id);

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

      await Promise.all([syncPlaidAccounts(item.id), syncPlaidTransactions(item.id)]);

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
  const { access_token, item_id } = await plaid.exchangePublicToken(user, public_token);
  return new Item({
    item_id,
    access_token,
    institution_id,
    status: ItemStatus.OK,
    provider: ItemProvider.PLAID,
  });
};

const exchangeSimpleFinToken = async (setupToken: string) => {
  const accessUrl = await simpleFin.exchangeSetupToken(setupToken);
  return new Item({
    item_id: randomUUID(),
    access_token: accessUrl,
    status: ItemStatus.OK,
    provider: ItemProvider.SIMPLE_FIN,
  });
};
