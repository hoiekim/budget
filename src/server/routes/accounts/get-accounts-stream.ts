import {
  Account,
  searchAccounts,
  getAccounts,
  Route,
  GetResponse,
  indexAccounts,
  AccountsResponse,
} from "server";

const getResponse: GetResponse<AccountsResponse> = async (req, res) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const map = new Map<string, Account>();

  const earlyResponse = { errors: [], accounts: await searchAccounts(user) };
  if (!earlyResponse.accounts) {
    throw new Error("Server failed to get middlestream accounts data.");
  }

  res.write(JSON.stringify({ status: "streaming", data: earlyResponse }));
  res.write("\n");

  earlyResponse.accounts.forEach((e) => map.set(e.account_id, e));

  const lateResponse = await getAccounts(user);
  if (!lateResponse) {
    throw new Error("Server failed to get upstream accounts data.");
  }

  lateResponse.accounts = lateResponse.accounts.map((e) => {
    const oldAccount = map.get(e.account_id);
    return oldAccount
      ? { ...oldAccount, ...e, name: oldAccount.name }
      : { ...e, config: { hide: false } };
  });

  res.write(JSON.stringify({ status: "success", data: lateResponse }));
  res.write("\n");

  indexAccounts(user, lateResponse.accounts);
};

const route = new Route("GET", "/accounts-stream", getResponse);

export default route;
