import {
  Route,
  Account,
  searchAccounts,
  getAccounts,
  upsertAccounts,
  Item,
  searchItems,
  getHoldings,
  Holding,
  upsertHoldings,
  Security,
  upsertSecurities,
  ApiResponse,
} from "server";

export interface AccountsStreamGetResponse {
  items: Item[];
  accounts: Account[];
  holdings: Holding[];
  securities: Security[];
}

export const getAccountsStreamRoute = new Route(
  "GET",
  "/accounts-stream",
  async (req, res) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        info: "Request user is not authenticated.",
      };
    }

    let counter = 0;
    const getStatus = (): ApiResponse["status"] => {
      if (counter > 1) return "success";
      counter++;
      return "streaming";
    };

    const map = new Map<string, Account>();

    const getAccountsFromElasticsearch = searchAccounts(user).then((r) => {
      const { accounts, holdings, securities } = r;
      const data: AccountsStreamGetResponse = {
        items: [],
        accounts,
        holdings,
        securities,
      };
      res.write(JSON.stringify({ status: getStatus(), data }) + "\n");
      accounts.forEach((e) => map.set(e.account_id, e));
    });

    const promisedItems = searchItems(user);

    const getAccountsFromPlaid = promisedItems
      .then((r) => getAccounts(user, r))
      .then(async (r) => {
        await getAccountsFromElasticsearch;

        const { items } = r;

        const accounts = r.accounts.map<Account>((e) => {
          const existingAccount = map.get(e.account_id);
          return existingAccount || { ...e, custom_name: "", hide: false, label: {} };
        });

        const data: AccountsStreamGetResponse = {
          items,
          accounts,
          holdings: [],
          securities: [],
        };

        res.write(JSON.stringify({ status: getStatus(), data }) + "\n");

        upsertAccounts(user, accounts);
      })
      .catch(console.error);

    const getHoldingsFromPlaid = promisedItems
      .then((r) => getHoldings(user, r))
      .then(async ({ items, accounts, holdings, securities }) => {
        await getAccountsFromElasticsearch;

        const filledAccounts = accounts.map<Account>((e) => {
          const existingAccount = map.get(e.account_id);
          return existingAccount || { ...e, custom_name: "", hide: false, label: {} };
        });

        const data: AccountsStreamGetResponse = {
          items,
          accounts: filledAccounts,
          holdings,
          securities,
        };

        res.write(JSON.stringify({ status: getStatus(), data }) + "\n");

        upsertAccounts(user, accounts);
        upsertHoldings(user, holdings);
        upsertSecurities(user, securities);
      })
      .catch(console.error);

    await Promise.all([
      getAccountsFromElasticsearch,
      getAccountsFromPlaid,
      getHoldingsFromPlaid,
    ]);
  }
);
