import { Route, deleteItem, saveLocalItems } from "server";

export const deleteItemRoute = new Route("DELETE", "/item", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const item_id = req.query.id as string;

  await deleteItem(user, item_id);

  user.items.find((e, i) => {
    if (e.item_id === item_id) {
      user.items.splice(i, 1);
      return true;
    }
  });

  if (user.username === "admin") saveLocalItems(user.items);

  return { status: "success" };
});
