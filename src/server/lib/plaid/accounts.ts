import { PlaidError, Products } from "plaid";
import { MaskedUser } from "server";
import { JSONItem, JSONHolding, JSONSecurity, PlaidAccount } from "common";
import { getClient, handlePlaidSyncError } from "./util";

export type ItemError = PlaidError & { item_id: string };

export const getAccounts = async (user: MaskedUser, items: JSONItem[]) => {
  const client = getClient(user);

  type PlaidAccountsResponse = {
    items: JSONItem[];
    accounts: PlaidAccount[];
  };

  const data: PlaidAccountsResponse = {
    items: [],
    accounts: [],
  };

  const allAccounts: PlaidAccount[][] = [];

  const fetchJobs = items.map(async (item) => {
    const { access_token } = item;
    try {
      const response = await client.accountsGet({ access_token });
      allAccounts.push(response.data.accounts as PlaidAccount[]);
      data.items.push({ ...item });
    } catch (error: unknown) {
      const { plaidError } = handlePlaidSyncError(error, {
        user,
        item,
        logLabel: "accounts",
        warnOnLoginRequired: true,
      });
      data.items.push({ ...item, plaidError });
    }

    return;
  });

  await Promise.all(fetchJobs);

  data.accounts = allAccounts.flat();

  return data;
};

export const getHoldings = async (user: MaskedUser, items: JSONItem[]) => {
  const client = getClient(user);

  type PlaidHoldingsResponse = {
    items: JSONItem[];
    accounts: PlaidAccount[];
    holdings: JSONHolding[];
    securities: JSONSecurity[];
  };

  const data: PlaidHoldingsResponse = {
    items: [],
    accounts: [],
    holdings: [],
    securities: [],
  };

  const allAccounts: PlaidAccount[][] = [];
  const allHoldings: JSONHolding[][] = [];
  const allSecurities: JSONSecurity[][] = [];

  const fetchJobs = items.map(async (item) => {
    const { access_token } = item;
    if (!item.available_products.includes(Products.Investments)) return;
    try {
      const response = await client.investmentsHoldingsGet({ access_token });
      const { accounts, holdings, securities } = response.data;

      allAccounts.push(accounts as PlaidAccount[]);

      const filledHoldings: JSONHolding[] = holdings.map((e) => {
        const holding_id = `${e.account_id}_${e.security_id}`;
        return { ...e, holding_id };
      });

      allHoldings.push(filledHoldings);
      allSecurities.push(securities);
      data.items.push({ ...item });
    } catch (error: unknown) {
      const { plaidError, outcome } = handlePlaidSyncError(error, {
        user,
        item,
        logLabel: "holdings",
        unsupportedMessage:
          "Holdings not supported for item, removing Investments from available_products",
      });
      if (outcome === "failed") {
        data.items.push({ ...item, plaidError });
      }
    }

    return;
  });

  await Promise.all(fetchJobs);

  data.accounts = allAccounts.flat();
  data.holdings = allHoldings.flat();
  data.securities = allSecurities.flat();

  return data;
};
