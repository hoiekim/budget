import {
  Route,
  searchAccounts,
  getAccounts,
  upsertAccounts,
  searchItems,
  getHoldings,
  upsertHoldings,
  upsertSecurities,
  ApiResponse,
} from "server";
import { Account, Item, Security, Holding } from "common";

export interface AccountsStreamGetResponse {
  items: Item[];
  accounts: Account[];
  holdings: Holding[];
  securities: Security[];
}

export const getAccountsStreamRoute = new Route(
  "GET",
  "/accounts-stream",
  async (req, res, stream) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const map = new Map<string, Account>();

    const getAccountsFromElasticsearch = searchAccounts(user).then((r) => {
      const { accounts, holdings, securities } = r;
      const body: AccountsStreamGetResponse = {
        items: [],
        accounts,
        holdings,
        securities,
      };
      stream({ status: "streaming", body });
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
          if (existingAccount) return new Account({ ...existingAccount, ...e });
          else return new Account(e);
        });

        const body: AccountsStreamGetResponse = {
          items,
          accounts,
          holdings: [],
          securities: [],
        };

        stream({ status: "streaming", body });

        upsertAccounts(user, accounts);
      })
      .catch(console.error);

    const getHoldingsFromPlaid = promisedItems
      .then((r) => getHoldings(user, r))
      .then(async ({ items, accounts, holdings, securities }) => {
        await getAccountsFromElasticsearch;

        const filledAccounts = accounts.map<Account>((e) => {
          const existingAccount = map.get(e.account_id);
          if (existingAccount) return new Account({ ...existingAccount, ...e });
          else return new Account(e);
        });

        const body: AccountsStreamGetResponse = {
          items,
          accounts: filledAccounts,
          holdings,
          securities,
        };

        stream({ status: "streaming", body });

        upsertAccounts(user, accounts);
        upsertHoldings(user, holdings);
        upsertSecurities(user, securities);
      })
      .catch(console.error);

    await Promise.all([getAccountsFromElasticsearch, getAccountsFromPlaid, getHoldingsFromPlaid]);

    stream({ status: "success" });
  }
);
