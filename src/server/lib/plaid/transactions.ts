import {
  TransactionsSyncRequest,
  Transaction,
  RemovedTransaction,
  PlaidError,
  InvestmentsTransactionsGetRequest,
  InvestmentTransaction,
} from "plaid";
import { MaskedUser, getPlaidClient, ignorable_error_codes } from "server";
import { Item, getDateString, getDateTimeString } from "common";

export interface PlaidTransaction extends Transaction {}

export const getTransactions = async (user: MaskedUser, items: Item[]) => {
  const client = getPlaidClient(user);

  type PlaidTransactionsResponse = {
    items: Item[];
    added: PlaidTransaction[];
    removed: RemovedTransaction[];
    modified: PlaidTransaction[];
  };

  const data: PlaidTransactionsResponse = {
    items: [],
    added: [],
    removed: [],
    modified: [],
  };

  const allAdded: PlaidTransaction[][] = [];
  const allRemoved: RemovedTransaction[][] = [];
  const allModified: PlaidTransaction[][] = [];

  const fetchJobs = items.map(async (item) => {
    const thisItemAdded: PlaidTransaction[][] = [];
    const thisItemRemoved: RemovedTransaction[][] = [];
    const thisItemModified: PlaidTransaction[][] = [];
    let hasMore = true;
    let plaidError: PlaidError | null = null;

    while (hasMore) {
      const { item_id, access_token, cursor } = item;

      try {
        const request: TransactionsSyncRequest = {
          access_token: access_token,
          cursor: cursor,
        };
        const response = await client.transactionsSync(request);
        const { added, removed, modified, has_more, next_cursor } = response.data;

        thisItemAdded.push(added);
        thisItemRemoved.push(removed);
        thisItemModified.push(modified);

        hasMore = has_more;
        item.cursor = next_cursor;
      } catch (error: any) {
        plaidError = error?.response?.data as PlaidError;
        console.error(plaidError || error);
        console.error("Failed to get transactions data for item:", item_id);
        hasMore = false;
      }
    }

    if (plaidError) data.items.push(new Item({ ...item, plaidError }));
    else data.items.push(new Item(item));

    allAdded.push(thisItemAdded.flat());
    allRemoved.push(thisItemRemoved.flat());
    allModified.push(thisItemModified.flat());

    return;
  });

  await Promise.all(fetchJobs);

  data.added = allAdded.flat();
  data.removed = allRemoved.flat();
  data.modified = allModified.flat();

  return data;
};

export interface PlaidInvestmentTransaction extends InvestmentTransaction {}

export const getInvestmentTransactions = async (user: MaskedUser, items: Item[]) => {
  const client = getPlaidClient(user);

  type PlaidInvestmentTransactionsResponse = {
    items: Item[];
    investmentTransactions: PlaidInvestmentTransaction[];
  };

  const data: PlaidInvestmentTransactionsResponse = {
    items: [],
    investmentTransactions: [],
  };

  const allInvestmentTransactions: PlaidInvestmentTransaction[][] = [];

  const fetchJobs = items.map(async (item) => {
    const { item_id, access_token, updated } = item;

    const now = new Date();

    let start_date: string;

    if (updated) {
      const updatedDate = new Date(getDateTimeString(updated));
      const date = updatedDate.getDate();
      updatedDate.setDate(date - 14);
      start_date = getDateString(updatedDate);
    } else {
      const oldestDate = new Date();
      const thisYear = now.getFullYear();
      oldestDate.setFullYear(thisYear - 2);
      start_date = getDateString(oldestDate);
    }

    const end_date = getDateString(now);

    const options = {
      count: 100,
      offset: 0,
    };

    const request: InvestmentsTransactionsGetRequest = {
      access_token,
      start_date,
      end_date,
      options,
    };

    let total: number | undefined;

    while (total === undefined || options.offset < total) {
      if (total === undefined) total = 0;

      try {
        const response = await client.investmentsTransactionsGet(request);
        const investmentTransactions = response.data.investment_transactions;
        total = response.data.total_investment_transactions;
        allInvestmentTransactions.push(investmentTransactions);
        item.updated = end_date;
        data.items.push(new Item(item));
      } catch (error: any) {
        const plaidError = error?.response?.data as PlaidError;
        if (!ignorable_error_codes.has(plaidError?.error_code)) {
          console.error(plaidError);
          console.error("Failed to get investment transaction data for item:", item_id);
          data.items.push(new Item({ ...item, plaidError }));
        }
      }

      options.offset += options.count;
    }
  });

  await Promise.all(fetchJobs);

  data.investmentTransactions = allInvestmentTransactions.flat();

  return data;
};
