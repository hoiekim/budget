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

  const earlyRequest = searchAccounts(user).then((accounts) => {
    const earlyResponse = { errors: [], accounts };
    res.write(JSON.stringify({ status: "streaming", data: earlyResponse }) + "\n");
    earlyResponse.accounts.forEach((e) => map.set(e.account_id, e));
  });

  const lateRequest = await getAccounts(user)
    .then(async (r) => {
      await earlyRequest;

      const accounts = r.accounts.map((e) => {
        const oldAccount = map.get(e.account_id);
        return oldAccount
          ? { ...oldAccount, ...e, name: oldAccount.name }
          : { ...e, config: { hide: false } };
      });

      const data = { ...r, accounts };

      res.write(JSON.stringify({ status: "success", data }) + "\n");

      indexAccounts(user, accounts);
    })
    .catch(console.error);

  await Promise.all([earlyRequest, lateRequest]);
};

const route = new Route("GET", "/accounts-stream", getResponse);

export default route;
