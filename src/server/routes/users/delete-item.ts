import { ItemProvider } from "common";
import { Route, deleteItem, plaid, searchItems } from "server";

export const deleteItemRoute = new Route("DELETE", "/item", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const item_id = req.query.id as string;

  const items = await searchItems(user);
  const item = items.find((e) => e.item_id === item_id);
  if (!item) {
    return {
      status: "failed",
      message: "Specified item is not owned by the request user",
    };
  }

  if (item.provider === ItemProvider.PLAID) {
    await plaid.deleteItem(user, item);
  }

  await deleteItem(user, item_id);

  return { status: "success" };
});
