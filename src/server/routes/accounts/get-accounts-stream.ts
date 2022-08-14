import {
  Route,
  GetResponse,
  Account,
  PlaidAccount,
  searchAccounts,
  getAccounts,
  indexAccounts,
  updateAccounts,
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
    const data: AccountsResponse = { errors: [], accounts };
    res.write(JSON.stringify({ status: "streaming", data }) + "\n");
    accounts.forEach((e) => map.set(e.account_id, e));
  });

  const lateRequest = getAccounts(user)
    .then(async (r) => {
      await earlyRequest;

      const added: Account[] = [];
      const modified: PlaidAccount[] = [];

      const accounts = r.accounts.map<Account>((e) => {
        const existingAccount = map.get(e.account_id);
        if (existingAccount) {
          modified.push(e);
          return existingAccount;
        }
        const account = { ...e, custom_name: "", labels: [] };
        added.push(account);
        return account;
      });

      const { errors } = r;

      const data: AccountsResponse = { errors, accounts };

      res.write(JSON.stringify({ status: "success", data }) + "\n");

      indexAccounts(user, added);
      updateAccounts(user, modified);
    })
    .catch(console.error);

  await Promise.all([earlyRequest, lateRequest]);
};

const route = new Route("GET", "/accounts-stream", getResponse);

export default route;
