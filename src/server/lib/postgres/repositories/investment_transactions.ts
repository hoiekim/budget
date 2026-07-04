import { randomUUID } from "crypto";
import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";
import { JSONInvestmentTransaction } from "common";
import {
  MaskedUser,
  InvTxModel,
  investmentTransactionsTable,
  INVESTMENT_TRANSACTION_ID,
  ACCOUNT_ID,
  USER_ID,
  DATE,
  QueryExecutor,
} from "../models";
import { UpsertResult, successResult, errorResult, noChangeResult } from "../database";
import { logger } from "../../logger";

export interface SearchInvestmentTransactionsOptions {
  account_id?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

export type PartialInvestmentTransaction = {
  investment_transaction_id: string;
} & Partial<JSONInvestmentTransaction>;

export const getInvestmentTransactions = async (
  user: MaskedUser,
  options: SearchInvestmentTransactionsOptions = {},
): Promise<JSONInvestmentTransaction[]> => {
  const models = await investmentTransactionsTable.query(
    { [USER_ID]: user.user_id, [ACCOUNT_ID]: options.account_id },
    {
      dateRange:
        options.startDate || options.endDate
          ? { column: DATE, start: options.startDate, end: options.endDate }
          : undefined,
      orderBy: `${DATE} DESC`,
      limit: options.limit,
      offset: options.offset,
    },
  );
  return models.map((m) => m.toJSON());
};

export const getInvestmentTransaction = async (
  user: MaskedUser,
  investment_transaction_id: string,
): Promise<JSONInvestmentTransaction | null> => {
  const model = await investmentTransactionsTable.queryOne({
    [USER_ID]: user.user_id,
    [INVESTMENT_TRANSACTION_ID]: investment_transaction_id,
  });
  return model?.toJSON() ?? null;
};

export const searchInvestmentTransactions = async (
  user: MaskedUser,
  options: SearchInvestmentTransactionsOptions = {},
): Promise<JSONInvestmentTransaction[]> => {
  return getInvestmentTransactions(user, options);
};

export const upsertInvestmentTransactions = async (
  user: MaskedUser,
  transactions: JSONInvestmentTransaction[],
  client?: QueryExecutor,
): Promise<UpsertResult[]> => {
  if (!transactions.length) return [];
  const results: UpsertResult[] = [];

  for (const tx of transactions) {
    try {
      const row = InvTxModel.fromJSON(tx, user.user_id);
      await investmentTransactionsTable.upsert(row, undefined, client);
      results.push(successResult(tx.investment_transaction_id, 1));
    } catch (error) {
      logger.error("Failed to upsert investment transaction", { investmentTransactionId: tx.investment_transaction_id }, error);
      results.push(errorResult(tx.investment_transaction_id));
    }
  }
  return results;
};

export const updateInvestmentTransactions = async (
  user: MaskedUser,
  transactions: PartialInvestmentTransaction[],
): Promise<UpsertResult[]> => {
  if (!transactions.length) return [];
  const results: UpsertResult[] = [];

  for (const tx of transactions) {
    try {
      const row = InvTxModel.fromJSON(tx, user.user_id);
      delete row.investment_transaction_id;
      delete row.user_id;

      const updated = await investmentTransactionsTable.update(tx.investment_transaction_id, row);
      results.push(
        updated
          ? successResult(tx.investment_transaction_id, 1)
          : noChangeResult(tx.investment_transaction_id),
      );
    } catch (error) {
      logger.error("Failed to update investment transaction", { investmentTransactionId: tx.investment_transaction_id }, error);
      results.push(errorResult(tx.investment_transaction_id));
    }
  }
  return results;
};

/**
 * Insert a shell `investment_transactions` row. Unlike the cash-side
 * `createManualTransaction`, this is NOT gated on `items.provider ===
 * MANUAL` — #585's motivating case (RSU/ESPP grants that predate
 * Plaid's 24-month window) lives on a Plaid-connected brokerage
 * account. Plaid sync only inserts/updates rows keyed by its own IDs,
 * so a manual UUID-shaped id has no collision surface.
 */
export const createManualInvestmentTransaction = async (
  user: MaskedUser,
  input: { account_id: string; security_id?: string | null },
): Promise<JSONInvestmentTransaction | null> => {
  const investment_transaction_id = `manual-${randomUUID()}`;
  const row = InvTxModel.fromJSON(
    {
      investment_transaction_id,
      account_id: input.account_id,
      security_id: input.security_id ?? null,
      date: new Date().toISOString().split("T")[0],
      name: "",
      amount: 0,
      quantity: 0,
      price: 0,
      iso_currency_code: null,
      type: InvestmentTransactionType.Buy,
      subtype: InvestmentTransactionSubtype.Buy,
      source: "manual",
    },
    user.user_id,
  );
  try {
    const result = await investmentTransactionsTable.insert(row, ["*"]);
    if (!result) return null;
    return new InvTxModel(result).toJSON();
  } catch (error) {
    logger.error("Failed to create manual investment transaction", { investment_transaction_id, account_id: input.account_id }, error);
    return null;
  }
};

export const deleteInvestmentTransactions = async (
  user: MaskedUser,
  transaction_ids: string[],
  client?: QueryExecutor,
): Promise<{ deleted: number }> => {
  if (!transaction_ids.length) return { deleted: 0 };
  const deleted = await investmentTransactionsTable.bulkSoftDelete(
    transaction_ids,
    { [USER_ID]: user.user_id },
    client,
  );
  return { deleted };
};
