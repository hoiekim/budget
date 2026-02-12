import { JSONHolding } from "common";
import {
  MaskedUser, HoldingModel, holdingsTable,
  HOLDING_ID, USER_ID, ACCOUNT_ID, SECURITY_ID, SNAPSHOTS,
} from "../models";
import { pool } from "../client";
import { UpsertResult, successResult, errorResult, noChangeResult } from "../database";

export type PartialHolding = { holding_id?: string; account_id: string; security_id: string } & Partial<JSONHolding>;

export const getHoldings = async (user: MaskedUser): Promise<JSONHolding[]> => {
  const models = await holdingsTable.query({ [USER_ID]: user.user_id });
  return models.map(m => m.toJSON());
};

export const getHolding = async (user: MaskedUser, holding_id: string): Promise<JSONHolding | null> => {
  const model = await holdingsTable.queryOne({ [USER_ID]: user.user_id, [HOLDING_ID]: holding_id });
  return model?.toJSON() ?? null;
};

export const getHoldingsByAccount = async (user: MaskedUser, account_id: string): Promise<JSONHolding[]> => {
  const models = await holdingsTable.query({ [USER_ID]: user.user_id, [ACCOUNT_ID]: account_id });
  return models.map(m => m.toJSON());
};

export const searchHoldings = async (
  user: MaskedUser,
  options: { holding_id?: string; account_id?: string; security_id?: string } = {}
): Promise<JSONHolding[]> => {
  const filters: Record<string, unknown> = { [USER_ID]: user.user_id };
  if (options.holding_id) filters[HOLDING_ID] = options.holding_id;
  if (options.account_id) filters[ACCOUNT_ID] = options.account_id;
  if (options.security_id) filters[SECURITY_ID] = options.security_id;
  
  const models = await holdingsTable.query(filters);
  return models.map(m => m.toJSON());
};

export const upsertHoldings = async (user: MaskedUser, holdings: JSONHolding[]): Promise<UpsertResult[]> => {
  if (!holdings.length) return [];
  const results: UpsertResult[] = [];

  for (const holding of holdings) {
    try {
      const row = HoldingModel.toRow(holding, user.user_id);
      const holdingId = (row.holding_id as string) || `${holding.account_id}-${holding.security_id}`;
      await holdingsTable.upsert(row);
      results.push(successResult(holdingId, 1));
    } catch (error) {
      const holdingId = holding.holding_id || `${holding.account_id}-${holding.security_id}`;
      console.error(`Failed to upsert holding ${holdingId}:`, error);
      results.push(errorResult(holdingId));
    }
  }
  return results;
};

export const updateHoldings = async (user: MaskedUser, holdings: PartialHolding[]): Promise<UpsertResult[]> => {
  if (!holdings.length) return [];
  const results: UpsertResult[] = [];

  for (const holding of holdings) {
    const holdingId = holding.holding_id || `${holding.account_id}-${holding.security_id}`;
    try {
      const row = HoldingModel.toRow(holding, user.user_id);
      delete row.holding_id;
      delete row.user_id;
      
      const updated = await holdingsTable.update(holdingId, row);
      results.push(updated ? successResult(holdingId, 1) : noChangeResult(holdingId));
    } catch (error) {
      console.error(`Failed to update holding ${holdingId}:`, error);
      results.push(errorResult(holdingId));
    }
  }
  return results;
};

export const deleteHoldings = async (user: MaskedUser, holding_ids: string[]): Promise<{ deleted: number }> => {
  if (!holding_ids.length) return { deleted: 0 };
  const { user_id } = user;
  const placeholders = holding_ids.map((_, i) => `$${i + 2}`).join(", ");

  await pool.query(
    `UPDATE ${SNAPSHOTS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE holding_account_id || '-' || holding_security_id IN (${placeholders}) AND ${USER_ID} = $1`,
    [user_id, ...holding_ids]
  );

  const result = await pool.query(
    `UPDATE holdings SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE ${HOLDING_ID} IN (${placeholders}) AND ${USER_ID} = $1 RETURNING ${HOLDING_ID}`,
    [user_id, ...holding_ids]
  );
  return { deleted: result.rowCount ?? 0 };
};

export const deleteHoldingsByAccount = async (user: MaskedUser, account_id: string): Promise<{ deleted: number }> => {
  const holdings = await getHoldingsByAccount(user, account_id);
  if (!holdings.length) return { deleted: 0 };
  return deleteHoldings(user, holdings.map(h => h.holding_id));
};

export const searchHoldingsByAccountId = async (user: MaskedUser, account_ids: string[]): Promise<JSONHolding[]> => {
  if (!account_ids.length) return [];
  const placeholders = account_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM holdings WHERE ${ACCOUNT_ID} IN (${placeholders}) AND ${USER_ID} = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user.user_id, ...account_ids]
  );
  return result.rows.map(row => new HoldingModel(row).toJSON());
};
