import {
  TransactionsSyncRequest,
  Transaction,
  RemovedTransaction,
  PlaidError,
  InvestmentsTransactionsGetRequest,
  InvestmentTransaction,
  PlaidErrorType,
  Products,
} from "plaid";
import { MaskedUser, updateItemStatus, upsertItems, logger } from "server";
import { JSONItem, ItemStatus, getDateString, LocalDate } from "common";
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
      } catch (error: unknown) {
        const errorWithResponse = error as { response?: { data?: PlaidError } };
        plaidError = errorWithResponse?.response?.data ?? null;
        if (plaidError?.error_code === "ITEM_LOGIN_REQUIRED") {
          logger.warn("Failed to get transactions data: ITEM_LOGIN_REQUIRED", { itemId: item_id });
        } else {
          logger.error("Failed to get transactions data", { itemId: item_id }, plaidError || error);
        }
        if (plaidError && plaidError.error_type === PlaidErrorType.ItemError) {
          updateItemStatus(user, item_id, ItemStatus.BAD, plaidError.error_code).catch((e) => {
            logger.error("Failed to update item status to BAD", { itemId: item_id }, e);
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

/**
 * Test seam for {@link getInvestmentTransactions}: the Plaid client factory
 * and the item writes it needs. Defaults are the production imports, so
 * callers pass nothing and behavior is unchanged. Tests pass fakes here
 * instead of mocking the shared leaves: mock.module is process-global in
 * Bun, and a module imported while a mock is registered keeps the mock —
 * mocking these leaves in the test file leaked into sibling test files
 * (mocked logger broke webhook.test.ts's warning throttle, mocked
 * upsertItems broke items.test.ts, mocked plaid util broke
 * get-institutions tests) whenever the suite ran together.
 */
export interface InvestmentTransactionDeps {
  getClient?: typeof getClient;
  upsertItems?: typeof upsertItems;
  updateItemStatus?: typeof updateItemStatus;
}

export const getInvestmentTransactions = async (
  user: MaskedUser,
  items: JSONItem[],
  deps: InvestmentTransactionDeps = {},
) => {
  const {
    getClient: getClientFn = getClient,
    upsertItems: upsertItemsFn = upsertItems,
    updateItemStatus: updateItemStatusFn = updateItemStatus,
  } = deps;
  const client = getClientFn(user);

  type PlaidInvestmentTransactionsResponse = {
    items: JSONItem[];
    investmentTransactions: PlaidInvestmentTransaction[];
  };

  const data: PlaidInvestmentTransactionsResponse = {
    items: [],
    investmentTransactions: [],
  };

  const allInvestmentTransactions: PlaidInvestmentTransaction[][] = [];

  const fetchJobs = items.map(async (_item) => {
    // Defensive copy: the watermark write below must not mutate the caller's
    // object (syncPlaidTransactions runs both branches against the same item).
    const item = { ..._item };
    const { item_id, access_token, updated } = item;
    if (!item.available_products.includes(Products.Investments)) return;

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
    let plaidError: PlaidError | null = null;
    let succeeded = false;

    while (total === undefined || options.offset < total) {
      if (total === undefined) total = 0;

      try {
        const response = await client.investmentsTransactionsGet(request);
        const investmentTransactions = response.data.investment_transactions;
        total = response.data.total_investment_transactions;
        allInvestmentTransactions.push(investmentTransactions);
        succeeded = true;
      } catch (error: unknown) {
        const errorWithResponse = error as { response?: { data?: PlaidError } };
        const errorData = errorWithResponse?.response?.data;
        const errorCode = errorData?.error_code;
        if (errorCode === "PRODUCTS_NOT_SUPPORTED") {
          logger.info(
            "Investment transactions not supported for item, removing Investments from available_products",
            { itemId: item_id },
          );
          const updated_products = item.available_products.filter(
            (p) => p !== Products.Investments,
          );
          upsertItemsFn(user, [{ ...item, available_products: updated_products }]).catch((e) => {
            logger.error("Failed to update available_products for item", { itemId: item_id }, e);
          });
          return;
        } else if (!errorCode || !ignorable_error_codes.has(errorCode)) {
          logger.error(
            "Failed to get investment transaction data",
            { itemId: item_id },
            errorData || error,
          );
          if (!plaidError) plaidError = errorData ?? null;
          if (errorData && errorData.error_type === PlaidErrorType.ItemError) {
            updateItemStatusFn(user, item_id, ItemStatus.BAD, errorData.error_code).catch((e) => {
              logger.error("Failed to update item status to BAD", { itemId: item_id }, e);
            });
          }
          break;
        }
      }

      options.offset += options.count;
    }

    // The watermark advances only when every page succeeded: this path is
    // offset-based, so a skipped offset is never revisited — unlike the
    // cursor-based cash path, where the cursor itself is the resume point.
    // The item is pushed exactly once per sync, never once per page.
    if (succeeded && !plaidError) item.updated = end_date;
    if (plaidError) data.items.push({ ...item, plaidError });
    else if (succeeded) data.items.push({ ...item });
  });

  await Promise.all(fetchJobs);

  data.investmentTransactions = allInvestmentTransactions.flat();

  return data;
};
