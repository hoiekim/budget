import { JSONHolding } from "common";
import {
  MaskedUser,
  HoldingModel,
  holdingsTable,
  USER_ID,
  ACCOUNT_ID,
  SECURITY_ID,
  INSTITUTION_PRICE,
  INSTITUTION_PRICE_AS_OF,
  INSTITUTION_VALUE,
  COST_BASIS,
  QUANTITY,
  ISO_CURRENCY_CODE,
  RAW,
  QueryExecutor,
} from "../models";
import { UpsertResult, successResult, errorResult } from "../database";
import { logger } from "../../logger";

export const getHoldings = async (user: MaskedUser): Promise<JSONHolding[]> => {
  const models = await holdingsTable.query({ [USER_ID]: user.user_id });
  return models.map((m) => m.toJSON());
};

/** Columns a holding conflict may rewrite. `holding_id` is derived from a
 *  caller-supplied `account_id`, so without an allowlist `Table.upsert`
 *  defaults to every supplied key and a colliding id reassigns the row's owner. */
const HOLDING_UPDATE_COLUMNS = [
  SECURITY_ID,
  INSTITUTION_PRICE,
  INSTITUTION_PRICE_AS_OF,
  INSTITUTION_VALUE,
  COST_BASIS,
  QUANTITY,
  ISO_CURRENCY_CODE,
  RAW,
];

export const upsertHoldings = async (
  user: MaskedUser,
  holdings: JSONHolding[],
): Promise<UpsertResult[]> => {
  if (!holdings.length) return [];
  const results: UpsertResult[] = [];

  for (const holding of holdings) {
    try {
      const row = HoldingModel.fromJSON(holding, user.user_id);
      const holdingId =
        (row.holding_id as string) || `${holding.account_id}-${holding.security_id}`;
      await holdingsTable.upsert(row, HOLDING_UPDATE_COLUMNS);
      results.push(successResult(holdingId, 1));
    } catch (error) {
      const holdingId = holding.holding_id || `${holding.account_id}-${holding.security_id}`;
      logger.error("Failed to upsert holding", { holdingId }, error);
      results.push(errorResult(holdingId));
    }
  }
  return results;
};

/**
 * One holdings row, throwing on failure. Inside a transaction a swallowed
 * error leaves Postgres aborted, and the COMMIT that follows rolls back
 * without raising, so the caller would report a write that never happened.
 */
export const upsertHoldingOrThrow = async (
  user: MaskedUser,
  holding: JSONHolding,
  client?: QueryExecutor,
): Promise<void> => {
  await holdingsTable.upsert(HoldingModel.fromJSON(holding, user.user_id), HOLDING_UPDATE_COLUMNS, client);
};

export const deleteHoldings = async (
  user: MaskedUser,
  holding_ids: string[],
): Promise<{ deleted: number }> => {
  if (!holding_ids.length) return { deleted: 0 };
  // Snapshots are intentionally NOT soft-deleted. The sync path
  // (`upsertHoldingsWithSnapshots` in compute-tools/create-snapshots.ts)
  // writes a fresh `quantity = 0` terminator snapshot for every removed
  // holding BEFORE calling this — that terminator is the deletion signal
  // historical readers (charts, performance calcs) consume.
  const deleted = await holdingsTable.bulkSoftDelete(holding_ids, { [USER_ID]: user.user_id });
  return { deleted };
};

export const searchHoldingsByAccountId = async (
  user: MaskedUser,
  account_ids: string[],
): Promise<JSONHolding[]> => {
  if (!account_ids.length) return [];
  const models = await holdingsTable.query(
    { [USER_ID]: user.user_id },
    { inFilters: { [ACCOUNT_ID]: account_ids } },
  );
  return models.map((m) => m.toJSON());
};
