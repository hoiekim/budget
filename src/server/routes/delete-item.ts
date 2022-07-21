import { Route, GetResponse, deleteItem, saveLocalItems } from "server";

const getResponse: GetResponse = async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const item_id = req.query.id as string;
  user.items.find((e, i) => {
    if (e.item_id === item_id) {
      user.items.splice(i, 1);
      return true;
    }
  });

  await deleteItem(user, item_id);

  if (user.username === "admin") saveLocalItems(user.items);

  return { status: "success" };
};

const route = new Route("DELETE", "/item", getResponse);

export default route;
