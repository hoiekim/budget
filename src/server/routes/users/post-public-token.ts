import {
  exchangePublicToken,
  Route,
  GetResponse,
  createItem,
  saveLocalItems,
  PbulicTokenResponse,
  Item,
} from "server";

const getResponse: GetResponse<PbulicTokenResponse> = async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const { public_token, institution_id } = req.body;
  if (typeof public_token !== "string") {
    return {
      status: "failed",
      info: "Request body has wrong type of public_token",
    };
  }

  const { access_token, item_id } = await exchangePublicToken(user, public_token);
  const item: Item = { item_id, access_token, institution_id };
  user.items.push(item);
  const response = await createItem(user, item);

  if (response.result !== "updated") {
    throw new Error(`Failed to register item: ${item_id}`);
  }

  if (user.username === "admin") {
    saveLocalItems(user.items);
  }

  return { status: "success", data: { item } };
};

const route = new Route("POST", "/public-token", getResponse);

export default route;
