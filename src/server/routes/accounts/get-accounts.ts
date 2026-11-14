import { JSONAccount, JSONHolding, JSONClientItem } from "common";
import { Route, searchAccounts, searchItems, getHoldings, toClientItem } from "server";

export interface AccountsGetResponse {
  items: JSONClientItem[];
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

  const [items, accounts, holdings] = await Promise.all([
    searchItems(user),
    searchAccounts(user),
    getHoldings(user),
  ]);
  // Items carry the Plaid/SimpleFin credential server-side; the browser gets
  // the credential-free projection (hoiekim/budget#807).
  const body = { items: items.map(toClientItem), accounts, holdings };

  return { status: "success", body };
});
