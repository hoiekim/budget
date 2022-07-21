import {
  Account,
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

  const map = new Map<string, Account>();

  const earlyResponse = await searchAccounts(user);
  if (!earlyResponse) {
    throw new Error("Server failed to get middlestream accounts data.");
  }

  res.write(
    JSON.stringify({ status: "streaming", data: { errors: [], accounts: earlyResponse } })
  );
  res.write("\n");

  earlyResponse.forEach((e) => map.set(e.account_id, e));

  const lateResponse = await getAccounts(user);
  if (!lateResponse) {
    throw new Error("Server failed to get upstream accounts data.");
  }

  res.write(JSON.stringify({ status: "success", data: lateResponse }));
  res.write("\n");

  indexAccounts(user, lateResponse.accounts);
};

const route = new Route("GET", "/accounts-stream", getResponse);

export default route;
