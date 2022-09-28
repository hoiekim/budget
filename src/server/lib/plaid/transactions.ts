import {
  TransactionsSyncRequest,
  Transaction as PlaidTransaction,
  RemovedTransaction,
  PlaidError,
  InvestmentsTransactionsGetRequest,
  InvestmentTransaction as PlaidInvestmentTransaction,
} from "plaid";
import { MaskedUser, Item, getPlaidClient, ignorable_error_codes } from "server";

export type { RemovedTransaction };

export interface TransactionLabel {
  budget_id?: string | null;
  category_id?: string | null;
}

export interface Transaction extends PlaidTransaction {
  /**
   * Represents relations by pair of budget_id and category_id
   */
  label: TransactionLabel;
}

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

    if (plaidError) data.items.push({ ...item, plaidError });
    else data.items.push({ ...item });

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

export type InvestmentTransaction = PlaidInvestmentTransaction;

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
    const { item_id, access_token } = item;

    const now = new Date();

    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const date = now.getDate();

    const month2Digits = month < 10 ? "0" + month : month.toString();
    const date2Digits = date < 10 ? "0" + date : date.toString();

    const request: InvestmentsTransactionsGetRequest = {
      access_token,
      start_date: `${year - 2}-${month2Digits}-${date2Digits}`,
      end_date: `${year}-${month2Digits}-${date2Digits}`,
    };

    let count = 100;
    let offset = 0;
    let total: number | undefined;

    while (total === undefined || offset < total) {
      if (total === undefined) total = 0;

      try {
        const response = await client.investmentsTransactionsGet(request);
        const investmentTransactions = response.data.investment_transactions;
        total = response.data.total_investment_transactions;
        allInvestmentTransactions.push(investmentTransactions);
      } catch (error: any) {
        const plaidError = error?.response?.data as PlaidError;
        if (!ignorable_error_codes.has(plaidError?.error_code)) {
          console.error(plaidError);
          console.error("Failed to get investment transaction data for item:", item_id);
          data.items.push({ ...item, plaidError });
        }
      }

      offset += count;
    }
  });

  await Promise.all(fetchJobs);

  data.investmentTransactions = allInvestmentTransactions.flat();

  return data;
};
