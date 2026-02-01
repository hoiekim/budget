import { JSONAccount, JSONHolding, JSONItem } from "common";
import { Route, searchAccounts, searchItems } from "server";

export interface AccountsGetResponse {
  items: JSONItem[];
  accounts: JSONAccount[];
  holdings: JSONHolding[];
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
  const { accounts, holdings } = accountsResponse;
  const body = { items, accounts, holdings };

  return { status: "success", body };
});
