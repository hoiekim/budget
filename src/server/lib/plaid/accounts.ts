import { PlaidError, PlaidErrorType, Products } from "plaid";
import { MaskedUser, updateItemStatus, upsertItems, logger, sendAlarm } from "server";
import { JSONItem, JSONHolding, JSONSecurity, ItemStatus, PlaidAccount } from "common";
import { getClient, ignorable_error_codes } from "./util";

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
    const { item_id, access_token } = item;
    try {
      const response = await client.accountsGet({ access_token });
      allAccounts.push(response.data.accounts as PlaidAccount[]);
      data.items.push({ ...item });
    } catch (error: unknown) {
      const errorWithResponse = error as { response?: { data?: PlaidError } };
      const plaidError = errorWithResponse?.response?.data;
      logger.error("Failed to get accounts data", { itemId: item_id }, plaidError || error);
      if (plaidError && plaidError.error_type === PlaidErrorType.ItemError) {
        updateItemStatus(item_id, ItemStatus.BAD).catch((e) => {
          logger.error("Failed to update item status to BAD", { itemId: item_id }, e);
        });
        sendAlarm(
          "Item Bad Status",
          `**Item:** ${item_id}\n**Reason:** ${plaidError.error_code}\n**Context:** getAccounts`,
        ).catch(() => undefined);
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
    const { item_id, access_token } = item;
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
      const errorWithResponse = error as { response?: { data?: PlaidError } };
      const plaidError = errorWithResponse?.response?.data;
      const errorCode = plaidError?.error_code;
      if (errorCode === "PRODUCTS_NOT_SUPPORTED") {
        logger.info("Holdings not supported for item, removing Investments from available_products", { itemId: item_id });
        const updated_products = item.available_products.filter((p) => p !== Products.Investments);
        upsertItems(user, [{ ...item, available_products: updated_products }]).catch((e) => {
          logger.error("Failed to update available_products for item", { itemId: item_id }, e);
        });
      } else if (!errorCode || !ignorable_error_codes.has(errorCode)) {
        logger.error("Failed to get holdings data", { itemId: item_id }, plaidError || error);
        if (plaidError && plaidError.error_type === PlaidErrorType.ItemError) {
          updateItemStatus(item_id, ItemStatus.BAD).catch((e) => {
            logger.error("Failed to update item status to BAD", { itemId: item_id }, e);
          });
          sendAlarm(
            "Item Bad Status",
            `**Item:** ${item_id}\n**Reason:** ${plaidError.error_code}\n**Context:** getHoldings`,
          ).catch(() => undefined);
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
