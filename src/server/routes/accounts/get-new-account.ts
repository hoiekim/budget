import { ItemProvider } from "common";
import {
  Route,
  createManualAccount,
  getItem,
  requireQueryString,
  validationError,
} from "server";

export type NewAccountGetResponse = { account_id: string; name: string };

/**
 * Mint a shell manual `accounts` row on a manual item. The FE inserts the
 * returned account into `data.accounts` and lets the user rename / retype
 * it from the connection detail page. Gated to `items.provider === MANUAL`
 * so a caller can't mint a shell account under a Plaid-synced item.
 *
 * Mirrors the sibling `get-new-transaction` / `get-new-investment-transaction`
 * routes — create is a distinct endpoint from edit, so the 304-sails-as-success
 * class of bug on `POST /account` (#668) is impossible by construction.
 */
export const getNewAccountRoute = new Route<NewAccountGetResponse>(
  "GET",
  "/new-account",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: "Request user is not authenticated." };

    const itemResult = requireQueryString(req, "item_id");
    if (!itemResult.success) return validationError(itemResult.error!);
    const item_id = itemResult.data!;

    const item = await getItem(user, item_id);
    if (!item) return { status: "failed", message: "Item not found." };
    if (item.provider !== ItemProvider.MANUAL) {
      return {
        status: "failed",
        message: "Manual accounts can only be created on manual items.",
      };
    }

    const created = await createManualAccount(user, { item_id });
    if (!created) return { status: "failed", message: "Failed to create account." };

    return {
      status: "success",
      body: { account_id: created.account_id, name: created.name },
    };
  },
);
