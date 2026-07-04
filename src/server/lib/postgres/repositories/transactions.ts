import { JSONTransaction, JSONInvestmentTransaction } from "common";
import {
  MaskedUser,
  TransactionModel,
  transactionsTable,
  investmentTransactionsTable,
  splitTransactionsTable,
  transactionPairsTable,
  TRANSACTION_ID,
  TRANSACTION_ID_A,
  TRANSACTION_ID_B,
  ACCOUNT_ID,
  USER_ID,
  DATE,
  UPDATED,
  QueryExecutor,
} from "../models";
import { UpsertResult, successResult, errorResult, noChangeResult } from "../database";
import { logger } from "../../logger";

export interface SearchTransactionsOptions {
  account_id?: string;
  account_ids?: string[];
  startDate?: string;
  endDate?: string;
  pending?: boolean;
  limit?: number;
  offset?: number;
  /** When true, soft-deleted (`is_deleted = TRUE`) rows are INCLUDED in
   *  the response so the client can treat them as tombstones and evict
   *  them from its local cache (IDB + in-memory dict). Defaults to
   *  `false` — consumers that filter to active-only rows (the engine,
   *  the sync-plaid delta computation) keep their previous behavior. */
  includeDeleted?: boolean;
}

export type PartialTransaction = { transaction_id: string } & Partial<JSONTransaction>;

export const getTransactions = async (
  user: MaskedUser,
  options: SearchTransactionsOptions = {},
): Promise<JSONTransaction[]> => {
  const models = await transactionsTable.query(
    {
      [USER_ID]: user.user_id,
      [ACCOUNT_ID]: options.account_id,
      pending: options.pending,
    },
    {
      dateRange:
        options.startDate || options.endDate
          ? { column: UPDATED, start: options.startDate, end: options.endDate }
          : undefined,
      orderBy: `${DATE} DESC`,
      limit: options.limit,
      offset: options.offset,
      excludeDeleted: !options.includeDeleted,
    },
  );
  return models.map((m) => m.toJSON());
};

export const getTransaction = async (
  user: MaskedUser,
  transaction_id: string,
): Promise<JSONTransaction | null> => {
  const model = await transactionsTable.queryOne({
    [USER_ID]: user.user_id,
    [TRANSACTION_ID]: transaction_id,
  });
  return model?.toJSON() ?? null;
};

export const searchTransactions = async (
  user: MaskedUser,
  options: SearchTransactionsOptions = {},
): Promise<{
  transactions: JSONTransaction[];
  investment_transactions: JSONInvestmentTransaction[];
}> => {
  const transactions = await getTransactions(user, options);

  const invModels = await investmentTransactionsTable.query(
    { [USER_ID]: user.user_id, [ACCOUNT_ID]: options.account_id },
    {
      dateRange:
        options.startDate || options.endDate
          ? { column: UPDATED, start: options.startDate, end: options.endDate }
          : undefined,
      orderBy: `${DATE} DESC`,
      limit: options.limit,
      offset: options.offset,
      excludeDeleted: !options.includeDeleted,
    },
  );
  const investment_transactions = invModels.map((m) => m.toJSON());

  return { transactions, investment_transactions };
};

export const searchTransactionsById = async (
  user: MaskedUser,
  transaction_ids: string[],
): Promise<JSONTransaction[]> => {
  if (!transaction_ids.length) return [];
  const models = await transactionsTable.queryByIds(transaction_ids, { [USER_ID]: user.user_id });
  return models.map((m) => m.toJSON());
};

export const upsertTransactions = async (
  user: MaskedUser,
  transactions: JSONTransaction[],
  client?: QueryExecutor,
): Promise<UpsertResult[]> => {
  if (!transactions.length) return [];
  const results: UpsertResult[] = [];

  for (const tx of transactions) {
    try {
      const row = TransactionModel.fromJSON(tx, user.user_id);
      await transactionsTable.upsert(row, undefined, client);
      results.push(successResult(tx.transaction_id, 1));
    } catch (error) {
      logger.error("Failed to upsert transaction", { transactionId: tx.transaction_id }, error);
      results.push(errorResult(tx.transaction_id));
    }
  }
  return results;
};

export const updateTransactions = async (
  user: MaskedUser,
  transactions: PartialTransaction[],
): Promise<UpsertResult[]> => {
  if (!transactions.length) return [];
  const results: UpsertResult[] = [];

  for (const tx of transactions) {
    try {
      const row = TransactionModel.fromJSON(tx, user.user_id);
      delete row.transaction_id;
      delete row.user_id;

      const updated = await transactionsTable.update(tx.transaction_id, row, undefined, user.user_id);
      results.push(
        updated ? successResult(tx.transaction_id, 1) : noChangeResult(tx.transaction_id),
      );
    } catch (error) {
      logger.error("Failed to update transaction", { transactionId: tx.transaction_id }, error);
      results.push(errorResult(tx.transaction_id));
    }
  }
  return results;
};

/**
 * Insert a shell `transactions` row for the user to fill in on the
 * detail page. Callers gate `account_id` on `items.provider === MANUAL`
 * so we don't accidentally create a duplicate manual row against a
 * Plaid-synced account (#567 acceptance criteria).
 */
export const createManualTransaction = async (
  user: MaskedUser,
  input: { account_id: string; iso_currency_code?: string | null },
): Promise<JSONTransaction> => {
  const { randomUUID } = await import("crypto");
  const transaction_id = `manual-${randomUUID()}`;
  const row = TransactionModel.fromJSON(
    {
      transaction_id,
      account_id: input.account_id,
      name: "",
      amount: 0,
      iso_currency_code: input.iso_currency_code ?? null,
      date: new Date().toISOString().split("T")[0],
      pending: false,
      source: "manual",
    },
    user.user_id,
  );
  const result = await transactionsTable.insert(row, ["*"]);
  if (!result) throw new Error("Failed to create manual transaction");
  return new TransactionModel(result).toJSON();
};

export const deleteTransactions = async (
  user: MaskedUser,
  transaction_ids: string[],
  client?: QueryExecutor,
): Promise<{ deleted: number }> => {
  if (!transaction_ids.length) return { deleted: 0 };

  // Soft-delete splits attached to each transaction (existing cascade).
  await splitTransactionsTable.bulkSoftDeleteByColumn(
    TRANSACTION_ID,
    transaction_ids,
    user.user_id,
    client,
  );

  // Cascade to transaction_pairs: a pair that references any soft-deleted
  // transaction must itself be soft-deleted, otherwise the surviving
  // counterpart stays "stuck" paired with a ghost — the engine sees it
  // as already-paired and refuses to suggest a new candidate. Plaid
  // pending+settled duplicates hit this path. Two UPDATEs per cascade
  // (one per join column) instead of 2N for N transactions.
  await transactionPairsTable.bulkSoftDeleteByColumn(
    TRANSACTION_ID_A,
    transaction_ids,
    user.user_id,
    client,
  );
  await transactionPairsTable.bulkSoftDeleteByColumn(
    TRANSACTION_ID_B,
    transaction_ids,
    user.user_id,
    client,
  );

  const deleted = await transactionsTable.bulkSoftDelete(
    transaction_ids,
    { [USER_ID]: user.user_id },
    client,
  );
  return { deleted };
};

export const searchTransactionsByAccountId = async (
  user: MaskedUser,
  account_ids: string[],
  range?: { start?: Date; end?: Date },
): Promise<{
  transactions: JSONTransaction[];
  investment_transactions: JSONInvestmentTransaction[];
}> => {
  if (!account_ids.length) return { transactions: [], investment_transactions: [] };

  const dateRange =
    range?.start || range?.end
      ? { column: DATE, start: range?.start, end: range?.end }
      : undefined;

  const [txModels, invModels] = await Promise.all([
    transactionsTable.query(
      { [USER_ID]: user.user_id },
      {
        inFilters: { [ACCOUNT_ID]: account_ids },
        dateRange,
        orderBy: `${DATE} DESC`,
      },
    ),
    investmentTransactionsTable.query(
      { [USER_ID]: user.user_id },
      {
        inFilters: { [ACCOUNT_ID]: account_ids },
        dateRange,
        orderBy: `${DATE} DESC`,
      },
    ),
  ]);

  return {
    transactions: txModels.map((m) => m.toJSON()),
    investment_transactions: invModels.map((m) => m.toJSON()),
  };
};
