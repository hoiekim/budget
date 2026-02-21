import { ItemProvider } from "common";
import { Route, deleteItem, plaid, searchItems, requireQueryString, validationError } from "server";

export const deleteItemRoute = new Route("DELETE", "/item", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const idResult = requireQueryString(req, "id");
  if (!idResult.success) return validationError(idResult.error!);

  const items = await searchItems(user);
  const item = items.find((e) => e.item_id === idResult.data);
  if (!item) {
    return {
      status: "failed",
      message: "Specified item is not owned by the request user",
    };
  }

  if (item.provider === ItemProvider.PLAID) {
    await plaid.deleteItem(user, item);
  }

  await deleteItem(user, idResult.data!);

  return { status: "success" };
});
