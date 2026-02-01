import { randomUUID } from "crypto";
import {
  plaid,
  simpleFin,
  Route,
  upsertItems,
  MaskedUser,
  syncSimpleFinData,
  syncPlaidAccounts,
  syncPlaidTransactions,
  searchItems,
} from "server";
import { getDateString, JSONItem, ItemProvider, ItemStatus, getRandomId } from "common";

export interface PbulicTokenPostResponse {
  item: JSONItem;
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
      await syncSimpleFinData(item.item_id);

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

      await Promise.all([syncPlaidAccounts(item.item_id), syncPlaidTransactions(item.item_id)]);

      return { status: "success", body: { item } };
    } else if (provider === ItemProvider.MANUAL) {
      const items = await searchItems(user);
      if (items.find((e) => e.provider === ItemProvider.MANUAL)) {
        return {
          status: "failed",
          message: "Manual item already exists for the user",
        };
      } else {
        const item: JSONItem = {
          item_id: getRandomId(),
          access_token: "no_access_token",
          provider,
          updated: getDateString(new Date()),
          status: ItemStatus.OK,
          institution_id: null,
          available_products: [],
        };
        await upsertItems(user, [item]);
        return { status: "success", body: { item } };
      }
    } else {
      return {
        status: "failed",
        message: "Request has wrong type of provider",
      };
    }
  },
);

const exchangePlaidToken = async (
  user: MaskedUser,
  public_token: string,
  institution_id: string,
): Promise<JSONItem> => {
  const { access_token, item_id } = await plaid.exchangePublicToken(user, public_token);
  const { consented_products = [], products = [] } = await plaid.getItem(access_token);
  return {
    item_id,
    access_token,
    institution_id,
    available_products: [...consented_products, ...products],
    status: ItemStatus.OK,
    provider: ItemProvider.PLAID,
  };
};

const exchangeSimpleFinToken = async (setupToken: string): Promise<JSONItem> => {
  const accessUrl = await simpleFin.exchangeSetupToken(setupToken);
  return {
    item_id: randomUUID(),
    access_token: accessUrl,
    status: ItemStatus.OK,
    provider: ItemProvider.SIMPLE_FIN,
    institution_id: null,
    available_products: [],
  };
};
