import { exchangePublicToken, Route, GetResponse, indexItem, Item } from "lib";

const getResponse: GetResponse = async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const token = req.body.token;
  const response = await exchangePublicToken(user, token);
  if (!response) throw new Error("Server failed to exchange token.");

  const item: Item = {
    id: response.item_id,
    token: response.access_token,
  };

  await indexItem(user, item);

  user.items.push(item);

  return { status: "success" };
};

const route = new Route("POST", "/public-token", getResponse);

export default route;
