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
  JSONHolding,
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
  migrateRejectedCategoriesOnPendingPosted,
  logger,
} from "server";
import {
  upsertAccountsWithSnapshots,
  upsertAndDeleteHoldingsWithSnapshots,
  upsertSecuritiesWithSnapshots,
} from "./create-snapshots";
import { inferCashHoldings } from "./cash-holding";
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

/**
 * Detect pending→posted transitions across a batch of incoming Plaid
 * transactions. Returns `{pending, posted}` pairs for downstream
 * migrations that need to follow the id rename (currently:
 * `rejected_categories` rows; future work may extend).
 *
 * Mechanism: Plaid's posted transaction carries
 * `pending_transaction_id` pointing back at the prior pending id. The
 * pair `(pending = e.pending_transaction_id, posted = e.transaction_id)`
 * is the canonical supersession event — no need to cross-check against
 * the stored set, since the back-pointer itself is the authoritative
 * signal from Plaid. The migrate helper is idempotent + no-ops when
 * the pending side has no rows, so an orphan back-pointer is harmless.
 */
export const detectPendingPostedTransitions = (
  incoming: Pick<JSONTransaction, "transaction_id" | "pending_transaction_id">[],
): Array<{ pending: string; posted: string }> => {
  const transitions: Array<{ pending: string; posted: string }> = [];
  for (const e of incoming) {
    const { pending_transaction_id: pending, transaction_id: posted } = e;
    if (pending && pending !== posted) transitions.push({ pending, posted });
  }
  return transitions;
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

/**
 * Rewrite each holding's `security_id` to the canonical id when the
 * securities-upsert dedupe folded Plaid's incoming id onto an existing
 * (user-minted) row's id. Pure — no side effects; separated for
 * per-input unit testing. When `idMap` has no entry for a holding's
 * `security_id`, or maps to the same id, the holding is returned
 * unchanged (identity-preserving so downstream `===` checks stay
 * stable). Closes #593 gap 2.
 */
export const remapHoldingSecurityIds = (
  holdings: JSONHolding[],
  idMap: { [key: string]: string },
): JSONHolding[] =>
  holdings.map((h) => {
    const canonical = idMap[h.security_id];
    if (!canonical || canonical === h.security_id) return h;
    return { ...h, security_id: canonical };
  });

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

      // Pending → posted transitions across both added and modified
      // batches. Used to migrate `rejected_categories` rows from the old
      // pending id to the new posted id after the posted row is upserted.
      const pendingPostedTransitions = detectPendingPostedTransitions([
        ...added,
        ...modified,
      ]);

      const updateJobs = [
        upsertTransactions(user, [...modeledAdded, ...modeledModified]),
        deleteTransactions(user, removedTransactionIds),
        ...removedTransactionIds.map((txId) => deleteSplitTransactionsByTransaction(user, txId)),
      ];

      const updated = getDateString();

      const partialItems = items.map(({ item_id, cursor }) => ({ item_id, cursor, updated }));
      return Promise.all(updateJobs)
        .then(async () => {
          // Migrate rejected_categories rows from each pending → posted
          // pair. Runs AFTER upsertTransactions so the posted FK target
          // exists. Each migration touches a distinct pending_transaction_id
          // with no shared rows across iterations, so parallelize with
          // allSettled — serial would chain 4 round-trips per migration
          // for first-sync / backfill batches. Failures are logged at warn
          // and do not interrupt counting; idempotent via ON CONFLICT DO
          // NOTHING inside the helper.
          const migrations = await Promise.allSettled(
            pendingPostedTransitions.map((t) =>
              migrateRejectedCategoriesOnPendingPosted(t.pending, t.posted),
            ),
          );
          migrations.forEach((m, i) => {
            if (m.status === "rejected") {
              const t = pendingPostedTransitions[i];
              logger.warn(
                "Failed to migrate rejected_categories on pending→posted",
                { pending: t.pending, posted: t.posted },
                m.reason,
              );
            }
          });
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

      // Auto-infer a USD cash holding for any investment account where
      // Plaid didn't surface cash as a holding. The inferred row is a
      // real holding snapshot — same data path as Plaid-provided cash —
      // so the UI is identical regardless of source.
      const inferredCash = await inferCashHoldings(accounts, holdings, securities);
      const allHoldings = inferredCash.length ? [...holdings, ...inferredCash] : holdings;

      await upsertAccountsWithSnapshots(user, accounts, storedAccounts);

      // Dedupe securities by ticker BEFORE writing holdings.
      // `upsertSecuritiesWithSnapshots` returns { incomingId → canonicalId }:
      // when the incoming ticker already exists in `securities` (e.g. a
      // user-minted row from `POST /api/validate-ticker` before Plaid
      // returned this position), the canonical id is the existing row's,
      // not Plaid's fresh id. Holdings written with Plaid's raw
      // `security_id` would then reference a soon-to-be-orphaned id after
      // the securities table upsert overwrites under the canonical id.
      // sync-simple-fin already does this correctly (idMap-remap before
      // writing holdings); sync-plaid was leaking the pre-dedupe ids
      // through to `holdings` and driving user-visible double-counting
      // when the user pre-registered the ticker manually. Closes #593
      // gap 2.
      const idMap = await upsertSecuritiesWithSnapshots(securities);
      const mappedHoldings = remapHoldingSecurityIds(allHoldings, idMap);
      await upsertAndDeleteHoldingsWithSnapshots(user, mappedHoldings, storedHoldings);

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
