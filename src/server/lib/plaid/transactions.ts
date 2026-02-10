import {
  TransactionsSyncRequest,
  Transaction,
  RemovedTransaction,
  PlaidError,
  InvestmentsTransactionsGetRequest,
  InvestmentTransaction,
  PlaidErrorType,
} from "plaid";
import { MaskedUser, updateItemStatus } from "server";
import { JSONItem, ItemStatus, getDateString, getDateTimeString, LocalDate } from "common";
import { getClient, ignorable_error_codes } from "./util";

export interface PlaidTransaction extends Transaction {}

export const getTransactions = async (user: MaskedUser, items: JSONItem[]) => {
  const client = getClient(user);

  type PlaidTransactionsResponse = {
    items: JSONItem[];
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

  const fetchJobs = items.map(async (_item) => {
    const item = { ..._item };
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
        if (plaidError && plaidError.error_type === PlaidErrorType.ItemError) {
          updateItemStatus(item_id, ItemStatus.BAD).catch((e) => {
            console.error("Failed to update item status to BAD:", e);
          });
        }
        hasMore = false;
      }
    }

    if (plaidError) data.items.push({ ...item, plaidError });
    else data.items.push(item);

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

export const getInvestmentTransactions = async (user: MaskedUser, items: JSONItem[]) => {
  const client = getClient(user);

  type PlaidInvestmentTransactionsResponse = {
    items: JSONItem[];
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
      const updatedDate = new LocalDate(updated);
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
        data.items.push({ ...item });
      } catch (error: any) {
        const plaidError = error?.response?.data as PlaidError;
        if (!ignorable_error_codes.has(plaidError?.error_code)) {
          console.error(plaidError);
          console.error("Failed to get investment transaction data for item:", item_id);
          if (plaidError && plaidError.error_type === PlaidErrorType.ItemError) {
            updateItemStatus(item_id, ItemStatus.BAD).catch((e) => {
              console.error("Failed to update item status to BAD:", e);
            });
          }
          data.items.push({ ...item, plaidError });
        }
      }

      options.offset += options.count;
    }
  });

  await Promise.all(fetchJobs);

  data.investmentTransactions = allInvestmentTransactions.flat();

  return data;
};
