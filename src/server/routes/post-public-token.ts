import {
  exchangePublicToken,
  getItem,
  Route,
  GetResponse,
  indexItem,
  saveLocalItems,
} from "server";

const getResponse: GetResponse = async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const token = req.body.token;
  const { access_token } = await exchangePublicToken(user, token);
  const item = await getItem(user, access_token);
  user.items.push(item);
  await indexItem(user, item);

  if (user.username === "admin") saveLocalItems(user.items);

  return { status: "success" };
};

const route = new Route("POST", "/public-token", getResponse);

export default route;
