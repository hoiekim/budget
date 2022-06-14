import { AccountBase } from "plaid";
import {
  searchAccounts,
  getAccounts,
  Route,
  GetResponse,
  indexAccounts,
} from "server";

const getResponse: GetResponse = async (req, res) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const map = new Map<string, AccountBase>();

  const earlyResponse = await searchAccounts(user);
  if (!earlyResponse) {
    throw new Error("Server failed to get middlestream accounts data.");
  }
  res.write(JSON.stringify({ status: "streaming", data: earlyResponse }));

  earlyResponse.forEach((e) => {
    map.set(e.account_id, e);
  });

  const lateResponse = await getAccounts(user);
  if (!lateResponse) {
    throw new Error("Server failed to get upstream accounts data.");
  }

  const moreResponse = lateResponse.filter((e) => !map.has(e.account_id));
  res.write(JSON.stringify({ status: "success", data: moreResponse }));

  indexAccounts(user, moreResponse);
};

const route = new Route("GET", "/accounts-stream", getResponse);

export default route;
