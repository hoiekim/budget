import { Route, deleteItem, removeLocalItem } from "server";

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

  if (user.username === "admin") removeLocalItem(item_id);

  return { status: "success" };
});
