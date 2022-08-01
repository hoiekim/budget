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

  const dependency = searchAccounts(user).then((accounts) => {
    const earlyResponse = { errors: [], accounts };
    res.write(JSON.stringify({ status: "streaming", data: earlyResponse }));
    res.write("\n");
    earlyResponse.accounts.forEach((e) => map.set(e.account_id, e));
  });

  await getAccounts(user).then(async (r) => {
    await dependency;
    const accounts = r.accounts.map((e) => {
      const oldAccount = map.get(e.account_id);
      return oldAccount
        ? { ...oldAccount, ...e, name: oldAccount.name }
        : { ...e, config: { hide: false } };
    });

    const data = { ...r, accounts };

    res.write(JSON.stringify({ status: "success", data }));
    res.write("\n");

    indexAccounts(user, accounts);
  });
};

const route = new Route("GET", "/accounts-stream", getResponse);

export default route;
