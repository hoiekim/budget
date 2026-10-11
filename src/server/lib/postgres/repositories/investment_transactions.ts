import { randomUUID } from "crypto";
import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";
import { JSONInvestmentTransaction } from "common";
import { pool } from "../client";
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
import {
  isNormalizableRow,
  intentOf,
  normalizeShareMovement,
  type ShareMovement,
} from "./normalize-investment-transaction";
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

/**
 * Rewrite a hand-entered purchase or sale into canonical form before it is
 * stored, taking the direction from whichever field this write supplied.
 *
 * Only fields whose value actually changes are added to the patch. The write
 * stays as narrow as the caller made it, so a column nobody touched is not
 * rewritten with a value read a moment earlier — which would turn a
 * concurrent edit of that column into a lost update.
 */
const normalizePatch = (
  patch: PartialInvestmentTransaction,
  existing: JSONInvestmentTransaction | undefined,
): PartialInvestmentTransaction => {
  if (!existing) return patch;

  const type = patch.type ?? existing.type;
  if (!isNormalizableRow(existing.source, type)) return patch;

  const merged: ShareMovement = {
    type,
    subtype: patch.subtype ?? existing.subtype ?? null,
    quantity: patch.quantity ?? existing.quantity ?? 0,
    price: patch.price ?? existing.price ?? 0,
    amount: patch.amount ?? existing.amount ?? 0,
  };

  const canonical = normalizeShareMovement(merged, intentOf(Object.keys(patch)));

  const result: PartialInvestmentTransaction = { ...patch };
  if (canonical.type !== merged.type) result.type = canonical.type;
  if (canonical.subtype !== merged.subtype) result.subtype = canonical.subtype;
  if (canonical.quantity !== merged.quantity) result.quantity = canonical.quantity;
  if (canonical.price !== merged.price) result.price = canonical.price;
  if (canonical.amount !== merged.amount) result.amount = canonical.amount;
  return result;
};

export const updateInvestmentTransactions = async (
  user: MaskedUser,
  transactions: PartialInvestmentTransaction[],
): Promise<UpsertResult[]> => {
  if (!transactions.length) return [];
  const results: UpsertResult[] = [];

  // One read for the whole batch, not one per transaction: a patch names
  // only the fields the editor just wrote, and the canonical form of a share
  // movement is a property of the merged row, so the stored values have to
  // be in hand before any of them can be rewritten.
  const existingById = new Map<string, JSONInvestmentTransaction>();
  const ids = transactions.map((t) => t.investment_transaction_id).filter(Boolean);
  if (ids.length) {
    const stored = await investmentTransactionsTable.query(
      { [USER_ID]: user.user_id },
      { inFilters: { [INVESTMENT_TRANSACTION_ID]: ids } },
    );
    for (const model of stored) existingById.set(model.investment_transaction_id, model.toJSON());
  }

  for (const tx of transactions) {
    try {
      const normalized = normalizePatch(tx, existingById.get(tx.investment_transaction_id));
      const row = InvTxModel.fromJSON(normalized, user.user_id);
      delete row.investment_transaction_id;
      delete row.user_id;

      // Scope the update to the caller's user_id — without this a
      // caller could patch another user's investment transaction by id.
      const updated = await investmentTransactionsTable.update(
        tx.investment_transaction_id,
        row,
        undefined,
        user.user_id,
      );
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
 * `createManualTransaction`, this is NOT gated on
 * `items.provider === MANUAL` — the motivating case (RSU/ESPP grants
 * that predate Plaid's 24-month window) lives on a Plaid-connected
 * brokerage account. Plaid sync only inserts/updates rows keyed by its
 * own IDs, so a manual UUID-shaped id has no collision surface.
 */
/** Same shape as `nextUnknownIndex` in `transactions.ts` — see that comment
 *  for the rationale on the "count soft-deleted" choice. */
const nextInvUnknownIndex = async (user_id: string): Promise<number> => {
  const sql =
    `SELECT COALESCE(MAX(CAST(SUBSTRING(name FROM '^Unknown_(\\d+)$') AS INTEGER)), 0) AS max ` +
    `FROM investment_transactions WHERE user_id = $1 AND name ~ '^Unknown_[0-9]+$'`;
  const result = await pool.query<{ max: number }>(sql, [user_id]);
  const currentMax = Number(result.rows[0]?.max ?? 0);
  return (Number.isFinite(currentMax) ? currentMax : 0) + 1;
};

export const createManualInvestmentTransaction = async (
  user: MaskedUser,
  input: {
    account_id: string;
    security_id?: string | null;
    // Holding-derived defaults. When the mint is triggered from the
    // holding detail page, the caller passes the holding's
    // `institution_price` and `iso_currency_code` so the shell starts
    // with a plausible non-zero price the user can confirm/correct.
    // From the account-level `+` (no holding context) these are
    // omitted and fall back to 0 / null.
    price?: number | null;
    iso_currency_code?: string | null;
    quantity?: number | null;
    /** YYYY-MM-DD. Defaults to today when omitted. */
    date?: string | null;
  },
): Promise<JSONInvestmentTransaction | null> => {
  const investment_transaction_id = `manual-${randomUUID()}`;
  const index = await nextInvUnknownIndex(user.user_id);
  const quantity = input.quantity ?? 0;
  const price = input.price ?? 0;
  // Derive `amount = quantity × price` when the caller provided both. The
  // TransactionsPage view filters out zero-amount investment rows
  // (`if (!e.amount) return false` in filteredAndSorted), so a mint that
  // prefills only quantity (the divergence "N missing units" action) would
  // land the row in DB but invisible in the tx list. Deriving here keeps
  // the row visible without requiring the FE to re-POST the amount after
  // the shell insert. Rounded to cents to match the client-side
  // `roundToCents` used in InvestmentTransactionProperties.
  // The caller varies `quantity` and never names a type — the reconciliation
  // action mints a negative one to mean "sell N units" — so the quantity is
  // what carries the direction here, and the type below is only a starting
  // point for it to correct.
  const canonical = normalizeShareMovement(
    {
      type: InvestmentTransactionType.Buy,
      subtype: InvestmentTransactionSubtype.Buy,
      quantity,
      price,
      amount: Math.round(quantity * price * 100) / 100,
    },
    "quantity",
  );
  const row = InvTxModel.fromJSON(
    {
      investment_transaction_id,
      account_id: input.account_id,
      security_id: input.security_id ?? null,
      date: input.date ?? new Date().toISOString().split("T")[0],
      name: `Unknown_${index}`,
      amount: canonical.amount,
      quantity: canonical.quantity,
      price: canonical.price,
      iso_currency_code: input.iso_currency_code ?? null,
      type: canonical.type,
      subtype: canonical.subtype ?? InvestmentTransactionSubtype.Buy,
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
