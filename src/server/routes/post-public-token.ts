import {
  exchangePublicToken,
  getItem,
  Route,
  GetResponse,
  indexItem,
  Item,
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
  const { item_id, access_token } = await exchangePublicToken(user, token);
  if (!item_id || !access_token) throw new Error("Server failed to exchange token.");

  const item: Item = { item_id, access_token };

  user.items.push(item);

  try {
    const { institution_id } = await getItem(user, access_token)
    if (institution_id) item.institution_id = institution_id
  } catch (error) {
    console.error(error)
    console.error(`Failed to get institution id for item: ${item_id}`)
  }

  await indexItem(user, item)

  return { status: "success" };
};

const route = new Route("POST", "/public-token", getResponse);

export default route;
