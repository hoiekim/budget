import { ItemProvider } from "common";
import {
  Route,
  deleteAccounts,
  searchAccountsById,
  getItem,
  deleteSnapshotsByAccount,
  requireQueryString,
  validationError,
} from "server";

export const deleteAccountRoute = new Route("DELETE", "/account", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const idResult = requireQueryString(req, "id");
  if (!idResult.success) {
    return validationError(idResult.error!);
  }
  const account_id = idResult.data!;

  const accounts = await searchAccountsById(user, [account_id]);
  const account = accounts[0];
  if (!account) {
    return {
      status: "failed",
      message: "Account not found.",
    };
  }

  const item = await getItem(user, account.item_id);
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

  await deleteAccounts(user, [account_id]);
  await deleteSnapshotsByAccount(user, account_id);

  return { status: "success" };
});
