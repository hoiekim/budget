import { PlaidError, PlaidErrorType } from "plaid";
import { MaskedUser, updateItemStatus } from "server";
import { JSONItem, JSONHolding, JSONSecurity, ItemStatus, JSONAccount } from "common";
import { getClient, ignorable_error_codes } from "./util";

export type ItemError = PlaidError & { item_id: string };

export const getAccounts = async (user: MaskedUser, items: JSONItem[]) => {
  const client = getClient(user);

  type PlaidAccountsResponse = {
    items: JSONItem[];
    accounts: JSONAccount[];
  };

  const data: PlaidAccountsResponse = {
    items: [],
    accounts: [],
  };

  const allAccounts: JSONAccount[][] = [];

  const fetchJobs = items.map(async (item) => {
    const { item_id, access_token, institution_id } = item;
    try {
      const response = await client.accountsGet({ access_token });
      const { accounts } = response.data;
      const filledAccounts: JSONAccount[] = accounts.map((e) => {
        return {
          ...e,
          institution_id: institution_id || "unknown",
          item_id,
          custom_name: "",
          hide: false,
          label: { budget_id: null },
          graphOptions: { useSnapshots: true, useTransactions: true },
        };
      });
      allAccounts.push(filledAccounts);
      data.items.push({ ...item });
    } catch (error: any) {
      const plaidError = error?.response?.data as PlaidError;
      console.error(plaidError);
      console.error("Failed to get accounts data for item:", item_id);
      if (plaidError && plaidError.error_type === PlaidErrorType.ItemError) {
        updateItemStatus(item_id, ItemStatus.BAD).catch((e) => {
          console.error("Failed to update item status to BAD:", e);
        });
      }
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
    accounts: JSONAccount[];
    holdings: JSONHolding[];
    securities: JSONSecurity[];
  };

  const data: PlaidHoldingsResponse = {
    items: [],
    accounts: [],
    holdings: [],
    securities: [],
  };

  const allAccounts: JSONAccount[][] = [];
  const allHoldings: JSONHolding[][] = [];
  const allSecurities: JSONSecurity[][] = [];

  const fetchJobs = items.map(async (item) => {
    const { item_id, access_token, institution_id } = item;
    try {
      const response = await client.investmentsHoldingsGet({ access_token });
      const { accounts, holdings, securities } = response.data;

      const filledAccounts: JSONAccount[] = accounts.map((e) => {
        return {
          ...e,
          institution_id: institution_id || "unknown",
          item_id,
          custom_name: "",
          hide: false,
          label: { budget_id: null },
          graphOptions: { useSnapshots: true, useTransactions: true },
        };
      });
      allAccounts.push(filledAccounts);

      const filledHoldings: JSONHolding[] = holdings.map((e) => {
        const holding_id = `${e.account_id}_${e.security_id}`;
        return { ...e, holding_id };
      });

      allHoldings.push(filledHoldings);
      allSecurities.push(securities);
      data.items.push({ ...item });
    } catch (error: any) {
      const plaidError = error?.response?.data as PlaidError;
      if (!ignorable_error_codes.has(plaidError?.error_code)) {
        console.error(plaidError);
        console.error("Failed to get holdings data for item:", item_id);
        if (plaidError && plaidError.error_type === PlaidErrorType.ItemError) {
          updateItemStatus(item_id, ItemStatus.BAD).catch((e) => {
            console.error("Failed to update item status to BAD:", e);
          });
        }
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
