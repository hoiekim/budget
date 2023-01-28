import {
  Route,
  deleteItem,
  removeLocalItem as deleteLocalItem,
  deletePlaidItem,
  searchItems,
} from "server";

export const deleteItemRoute = new Route("DELETE", "/item", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const item_id = req.query.id as string;

  const items = await searchItems(user);
  const item = items.find((e) => e.item_id === item_id);
  if (!item) {
    return {
      status: "failed",
      info: "Specified item is not owned by the request user",
    };
  }

  await deletePlaidItem(user, item);
  await deleteItem(user, item_id);

  if (user.username === "admin") deleteLocalItem(item_id);

  return { status: "success" };
});
