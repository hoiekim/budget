import { Account, Holding, Item, Security } from "common";
import { Route, searchAccounts, searchItems } from "server";

export interface AccountsGetResponse {
  items: Item[];
  accounts: Account[];
  holdings: Holding[];
  securities: Security[];
}

export const getAccountsRoute = new Route<AccountsGetResponse>("GET", "/accounts", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const [items, accountsResponse] = await Promise.all([searchItems(user), searchAccounts(user)]);
  const { accounts, holdings, securities } = accountsResponse;
  const body = { items, accounts, holdings, securities };

  return { status: "success", body };
});
