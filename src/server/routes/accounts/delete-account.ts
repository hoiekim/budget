import { ItemProvider } from "common";
import {
  Route,
  deleteAccounts,
  searchAccountsById,
  getItem,
  deleteSnapshotsByAccount,
} from "server";

export const deleteAccountRoute = new Route("DELETE", "/account", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const account_id = req.query.id as string;

  const accounts = await searchAccountsById(user, [account_id]);
  const account = accounts[0];
  if (!account) {
    return {
      status: "failed",
      message: "Account not found.",
    };
  }

  const item = await getItem(account.item_id);
  if (!item) {
    return {
      status: "failed",
      message: "Item not found.",
    };
  }

  if (item.provider !== ItemProvider.MANUAL) {
    return {
      status: "failed",
      message: "Account is not a manual account.",
    };
  }

  await deleteAccounts(user, [{ account_id }]);
  await deleteSnapshotsByAccount(user, [{ account: { account_id } }]);

  return { status: "success" };
});
