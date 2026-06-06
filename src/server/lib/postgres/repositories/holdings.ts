import { JSONHolding } from "common";
import {
  MaskedUser,
  HoldingModel,
  holdingsTable,
  HOLDING_ID,
  USER_ID,
  ACCOUNT_ID,
  SECURITY_ID,
} from "../models";
import { UpsertResult, successResult, errorResult, noChangeResult } from "../database";
import { logger } from "../../logger";

export type PartialHolding = {
  holding_id?: string;
  account_id: string;
  security_id: string;
} & Partial<JSONHolding>;

export const getHoldings = async (user: MaskedUser): Promise<JSONHolding[]> => {
  const models = await holdingsTable.query({ [USER_ID]: user.user_id });
  return models.map((m) => m.toJSON());
};

export const getHolding = async (
  user: MaskedUser,
  holding_id: string,
): Promise<JSONHolding | null> => {
  const model = await holdingsTable.queryOne({ [USER_ID]: user.user_id, [HOLDING_ID]: holding_id });
  return model?.toJSON() ?? null;
};

export const getHoldingsByAccount = async (
  user: MaskedUser,
  account_id: string,
): Promise<JSONHolding[]> => {
  const models = await holdingsTable.query({ [USER_ID]: user.user_id, [ACCOUNT_ID]: account_id });
  return models.map((m) => m.toJSON());
};

export const searchHoldings = async (
  user: MaskedUser,
  options: { holding_id?: string; account_id?: string; security_id?: string } = {},
): Promise<JSONHolding[]> => {
  const filters: Record<string, unknown> = { [USER_ID]: user.user_id };
  if (options.holding_id) filters[HOLDING_ID] = options.holding_id;
  if (options.account_id) filters[ACCOUNT_ID] = options.account_id;
  if (options.security_id) filters[SECURITY_ID] = options.security_id;

  const models = await holdingsTable.query(filters);
  return models.map((m) => m.toJSON());
};

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
      await holdingsTable.upsert(row);
      results.push(successResult(holdingId, 1));
    } catch (error) {
      const holdingId = holding.holding_id || `${holding.account_id}-${holding.security_id}`;
      logger.error("Failed to upsert holding", { holdingId }, error);
      results.push(errorResult(holdingId));
    }
  }
  return results;
};

export const updateHoldings = async (
  user: MaskedUser,
  holdings: PartialHolding[],
): Promise<UpsertResult[]> => {
  if (!holdings.length) return [];
  const results: UpsertResult[] = [];

  for (const holding of holdings) {
    const holdingId = holding.holding_id || `${holding.account_id}-${holding.security_id}`;
    try {
      const row = HoldingModel.fromJSON(holding, user.user_id);
      delete row.holding_id;
      delete row.user_id;

      const updated = await holdingsTable.update(holdingId, row);
      results.push(updated ? successResult(holdingId, 1) : noChangeResult(holdingId));
    } catch (error) {
      logger.error("Failed to update holding", { holdingId }, error);
      results.push(errorResult(holdingId));
    }
  }
  return results;
};

export const deleteHoldings = async (
  user: MaskedUser,
  holding_ids: string[],
): Promise<{ deleted: number }> => {
  if (!holding_ids.length) return { deleted: 0 };
  // Snapshots are intentionally NOT soft-deleted. The sync path
  // (`upsertHoldingsWithSnapshots` in compute-tools/create-snapshots.ts)
  // writes a fresh `quantity = 0` terminator snapshot for every removed
  // holding BEFORE calling this — that terminator is the deletion
  // signal historical readers (charts, performance calcs) consume.
  // Earlier this function wiped the entire account's snapshot history
  // (filtering by `holding_account_id` only — see #471) which silently
  // erased every holding's history when a single position was removed.
  // The fix is not a tighter filter on the soft-delete; it's removing
  // the soft-delete entirely.
  const deleted = await holdingsTable.bulkSoftDelete(holding_ids, { [USER_ID]: user.user_id });
  return { deleted };
};

export const deleteHoldingsByAccount = async (
  user: MaskedUser,
  account_id: string,
): Promise<{ deleted: number }> => {
  const holdings = await getHoldingsByAccount(user, account_id);
  if (!holdings.length) return { deleted: 0 };
  return deleteHoldings(
    user,
    holdings.map((h) => h.holding_id),
  );
};

export const searchHoldingsByAccountId = async (
  user: MaskedUser,
  account_ids: string[],
): Promise<JSONHolding[]> => {
  if (!account_ids.length) return [];
  const results: JSONHolding[] = [];
  for (const account_id of account_ids) {
    const models = await holdingsTable.query({ [ACCOUNT_ID]: account_id, [USER_ID]: user.user_id });
    results.push(...models.map((m) => m.toJSON()));
  }
  return results;
};
