import {
  JSONAccount,
  JSONItem,
  ItemProvider,
  RemovedInvestmentTransaction,
  TWO_WEEKS,
  JSONTransaction,
  getDateString,
  getDateTimeString,
  JSONInvestmentTransaction,
  isDate,
  LocalDate,
  DEFAULT_GRAPH_OPTIONS,
  PlaidAccount,
} from "common";
import {
  deleteInvestmentTransactions,
  deleteTransactions,
  plaid,
  getUserItem,
  upsertInvestmentTransactions,
  upsertItems,
  upsertTransactions,
  searchAccountsByItemId,
  searchTransactionsByAccountId,
  searchHoldingsByAccountId,
  MaskedUser,
  deleteSplitTransactionsByTransaction,
  logger,
} from "server";
import {
  upsertAccountsWithSnapshots,
  upsertAndDeleteHoldingsWithSnapshots,
  upsertSecuritiesWithSnapshots,
} from "./create-snapshots";
import { Products } from "plaid";

/** Build O(n) lookup maps for stored transactions to avoid O(n²) in modelize. */
export const buildTransactionLookupMaps = (
  storedTransactions: JSONTransaction[],
): {
  byTransactionId: Map<string, JSONTransaction>;
  byPendingId: Map<string, JSONTransaction>;
  byCompoundKey: Map<string, JSONTransaction>;
} => {
  const byTransactionId = new Map<string, JSONTransaction>();
  const byPendingId = new Map<string, JSONTransaction>();
  const byCompoundKey = new Map<string, JSONTransaction>();
  for (const f of storedTransactions) {
    byTransactionId.set(f.transaction_id, f);
    if (f.pending_transaction_id) byPendingId.set(f.pending_transaction_id, f);
    byCompoundKey.set(`${f.account_id}:${f.name}:${f.amount}`, f);
  }
  return { byTransactionId, byPendingId, byCompoundKey };
};

/** Find the stored transaction matching an incoming Plaid transaction using O(1) map lookups. */
export const findStoredTransaction = (
  incoming: Pick<JSONTransaction, "transaction_id" | "account_id" | "name" | "amount">,
  maps: ReturnType<typeof buildTransactionLookupMaps>,
): JSONTransaction | undefined => {
  return (
    maps.byTransactionId.get(incoming.transaction_id) ??
    maps.byPendingId.get(incoming.transaction_id) ??
    maps.byCompoundKey.get(`${incoming.account_id}:${incoming.name}:${incoming.amount}`)
  );
};

/** Identify recently-stored investment transactions that are no longer in the incoming list. */
export const getPlaidRemovedInvestmentTransactions = (
  incomingTransactions: JSONInvestmentTransaction[],
  storedTransactions: JSONInvestmentTransaction[],
): RemovedInvestmentTransaction[] => {
  const incomingIds = new Set(incomingTransactions.map((f) => f.investment_transaction_id));
  const removed: RemovedInvestmentTransaction[] = [];
  storedTransactions.forEach((e) => {
    const age = new Date().getTime() - new LocalDate(e.date).getTime();
    if (age > TWO_WEEKS) return;
    if (!incomingIds.has(e.investment_transaction_id)) {
      removed.push({ investment_transaction_id: e.investment_transaction_id });
    }
  });
  return removed;
};

export const syncPlaidTransactions = async (item_id: string) => {
  const userItem = await getUserItem(item_id);
  if (!userItem) return;
  const { user, item } = userItem;
  if (item.provider !== ItemProvider.PLAID) return;

  const accounts = await searchAccountsByItemId(user, item_id);
  const accountIds = accounts?.map((e) => e.account_id) || [];

  const itemUpdated = item.updated ? new LocalDate(item.updated) : undefined;
  const startDate = itemUpdated ? getOneMonthBefore(itemUpdated) : getTwoYearsAgo();

  const range = { start: startDate, end: new Date() };
  const storedTransactionsPromise = searchTransactionsByAccountId(user, accountIds, range);

  let addedCount = 0;
  let modifiedCount = 0;
  let removedCount = 0;

  const syncTransactions =
    item.available_products.includes(Products.Transactions) &&
    plaid.getTransactions(user, [item]).then(async (r) => {
      const storedTransactionsResult = await storedTransactionsPromise;
      const storedTransactions = storedTransactionsResult.transactions || [];

      const { items, added, removed, modified } = r;

      const lookupMaps = buildTransactionLookupMaps(storedTransactions);

      const modelize = (e: (typeof added)[0]) => {
        const result: JSONTransaction = { ...e, label: {} };
        const { authorized_date: auth_date, date } = e;
        if (auth_date) result.authorized_date = getDateTimeString(auth_date);
        if (date) result.date = getDateTimeString(date);
        const existing = findStoredTransaction(e, lookupMaps);
        if (existing) result.label = existing.label;
        return result;
      };

      const modeledAdded = added.map(modelize);
      const modeledModified = modified.map(modelize);
      const removedTransactionIds = removed.map((e) => e.transaction_id);

      const updateJobs = [
        upsertTransactions(user, [...modeledAdded, ...modeledModified]),
        deleteTransactions(user, removedTransactionIds),
        ...removedTransactionIds.map((txId) => deleteSplitTransactionsByTransaction(user, txId)),
      ];

      const updated = getDateString();

      const partialItems = items.map(({ item_id, cursor }) => ({ item_id, cursor, updated }));
      return Promise.all(updateJobs)
        .then(() => {
          addedCount += added.length;
          modifiedCount += modified.length;
          removedCount += removed.length;
        })
        .then(() => upsertItems(user, partialItems))
        .catch((err) => {
          logger.error("Error occurred during storing Plaid transactions data", { itemId: item_id }, err);
          throw err; // Re-throw to propagate error to caller
        });
    });

  const syncInvestmentTransactions =
    item.available_products.includes(Products.Investments) &&
    plaid.getInvestmentTransactions(user, [item]).then(async (r) => {
      const { items, investmentTransactions } = r;

      const fillDateStrings = (e: (typeof investmentTransactions)[0]) => {
        const result: JSONInvestmentTransaction = { ...e, label: {} };
        const { date } = e;
        if (date) result.date = getDateTimeString(date);
        return result;
      };

      const filledInvestments = investmentTransactions.map(fillDateStrings);

      // Get stored investment transactions
      const storedTransactionsResult = await storedTransactionsPromise;
      const storedInvestmentTransactions = storedTransactionsResult.investment_transactions || [];

      const removed = getPlaidRemovedInvestmentTransactions(
        filledInvestments,
        storedInvestmentTransactions,
      );
      const removedIdSet = new Set(removed.map((r) => r.investment_transaction_id));

      // Adjust counters for recent stored transactions that are still present (modified).
      storedInvestmentTransactions.forEach((e) => {
        const age = new Date().getTime() - new LocalDate(e.date).getTime();
        if (age > TWO_WEEKS) return;
        if (!removedIdSet.has(e.investment_transaction_id)) {
          modifiedCount += 1;
          addedCount -= 1;
        }
      });

      const removedIds = removed.map((r) => r.investment_transaction_id);

      const updateJobs = [
        upsertInvestmentTransactions(user, filledInvestments),
        deleteInvestmentTransactions(user, removedIds),
      ];

      const partialItems = items.map(({ item_id, updated }) => ({ item_id, updated }));
      return Promise.all(updateJobs)
        .then(() => {
          addedCount += filledInvestments.length;
          removedCount += removed.length;
        })
        .then(() => upsertItems(user, partialItems))
        .catch((err) => {
          logger.error("Error occurred during storing Plaid investment transactions data", { itemId: item_id }, err);
          throw err; // Re-throw to propagate error to caller
        });
    });

  await Promise.all([syncTransactions, syncInvestmentTransactions]);

  return {
    added: addedCount,
    modified: modifiedCount,
    removed: removedCount,
  };
};

export const syncPlaidAccounts = async (item_id: string) => {
  const userItem = await getUserItem(item_id);
  if (!userItem) return;
  const { user, item } = userItem;
  if (item.provider !== ItemProvider.PLAID) return;

  const { accounts: storedAccounts, holdings: storedHoldings } = await getStoredAccountsData(
    user,
    item,
  );
  const storedAccountsMap = new Map(storedAccounts?.map((e) => [e.account_id, e]) || []);
  const mergeWithExisting = (a: PlaidAccount): JSONAccount => {
    const existing = storedAccountsMap.get(a.account_id);
    return {
      ...a,
      institution_id: item.institution_id || "unknown",
      item_id: item.item_id,
      hide: existing?.hide ?? false,
      custom_name: existing?.custom_name ?? "",
      label: existing?.label ?? { budget_id: null },
      graphOptions: existing?.graphOptions ?? DEFAULT_GRAPH_OPTIONS,
    };
  };

  const syncAccounts = plaid
    .getAccounts(user, [item])
    .then(async (r) => r.accounts.map(mergeWithExisting))
    .then(async (accounts) => {
      await upsertAccountsWithSnapshots(user, accounts, storedAccounts);
      return accounts;
    })
    .catch((error) => {
      logger.error("Sync accounts failed", { itemId: item_id }, error);
      throw error; // Re-throw to propagate error to caller
    });

  const isInvestmentAvailable = item.available_products.includes(Products.Investments);
  const syncHoldings = Promise.resolve(isInvestmentAvailable)
    .then((r) => {
      if (!r) return;
      return plaid.getHoldings(user, [item]);
    })
    .then(async (r) => {
      if (!r) return;
      const accounts = r.accounts.map(mergeWithExisting);
      const { holdings, securities } = r;
      await upsertAccountsWithSnapshots(user, accounts, storedAccounts);
      await upsertAndDeleteHoldingsWithSnapshots(user, holdings, storedHoldings);
      await upsertSecuritiesWithSnapshots(securities);
      return accounts;
    })
    .catch((error) => {
      logger.error("Sync holdings failed", { itemId: item_id }, error);
      throw error; // Re-throw to propagate error to caller
    });

  const [accounts, investmentAccounts] = await Promise.all([syncAccounts, syncHoldings]);
  return { accounts, investmentAccounts };
};

const getStoredAccountsData = async (user: MaskedUser, item: JSONItem) => {
  const { item_id } = item;
  const accounts = await searchAccountsByItemId(user, item_id);
  const accountIds = accounts?.map((e) => e.account_id) || [];
  const holdings = await searchHoldingsByAccountId(user, accountIds);
  return { accounts, holdings };
};

const getTwoYearsAgo = () => {
  const oldestDate = new Date();
  const thisYear = new Date().getFullYear();
  oldestDate.setFullYear(thisYear - 2);
  return oldestDate;
};

const getOneMonthBefore = (date?: Date) => {
  const newDate = isDate(date) ? new Date(date) : new Date();
  newDate.setMonth(newDate.getMonth() - 1);
  return newDate;
};
