import { JSONItem, ItemProvider } from "common";
import {
  MaskedUser,
  ItemModel,
  itemsTable,
  accountsTable,
  transactionsTable,
  investmentTransactionsTable,
  splitTransactionsTable,
  snapshotsTable,
  holdingsTable,
  ITEM_ID,
  USER_ID,
  ACCESS_TOKEN,
  INSTITUTION_ID,
  AVAILABLE_PRODUCTS,
  CURSOR,
  STATUS,
  STATUS_REASON,
  PROVIDER,
  LAST_SYNC_STATUS,
  LAST_SYNC_AT,
  LAST_SYNC_ERROR,
  RAW,
  ACCOUNT_ID,
  HOLDING_ACCOUNT_ID,
  QueryExecutor,
} from "../models";
import { softDeleteTransactionPairsByAccounts } from "./transactions";
import { pool, withTransaction } from "../client";
import { UpsertResult, successResult, errorResult } from "../database";
import { logger } from "../../logger";

export type PartialItem = { item_id: string } & Partial<JSONItem>;

export const getItems = async (user: MaskedUser): Promise<JSONItem[]> => {
  const models = await itemsTable.query({ [USER_ID]: user.user_id });
  return models.map((m) => m.toJSON());
};

export const getItem = async (user: MaskedUser, item_id: string): Promise<JSONItem | null> => {
  const model = await itemsTable.queryOne({ [USER_ID]: user.user_id, [ITEM_ID]: item_id });
  return model?.toJSON() ?? null;
};

export const getAllItems = async (): Promise<JSONItem[]> => {
  const models = await itemsTable.query({});
  return models.map((m) => m.toJSON());
};

export const searchItems = async (
  user: MaskedUser,
  options: { item_id?: string; institution_id?: string; provider?: ItemProvider } = {},
): Promise<JSONItem[]> => {
  const filters: Record<string, unknown> = { [USER_ID]: user.user_id };
  if (options.item_id) filters[ITEM_ID] = options.item_id;
  if (options.institution_id) filters[INSTITUTION_ID] = options.institution_id;
  if (options.provider) filters.provider = options.provider;

  const models = await itemsTable.query(filters);
  return models.map((m) => m.toJSON());
};

export const getItemByAccessToken = async (access_token: string): Promise<JSONItem | null> => {
  const model = await itemsTable.queryOne({ access_token });
  return model?.toJSON() ?? null;
};

export const getItemsByInstitution = async (
  user: MaskedUser,
  institution_id: string,
): Promise<JSONItem[]> => {
  const models = await itemsTable.query({
    [USER_ID]: user.user_id,
    [INSTITUTION_ID]: institution_id,
  });
  return models.map((m) => m.toJSON());
};

export const getUserItem = async (
  item_id: string,
): Promise<{ user: MaskedUser; item: JSONItem } | null> => {
  // JOIN with users to attach `username` — outside Table.query's surface.
  const result = await pool.query<Record<string, unknown> & { username: string }>(
    `SELECT i.*, u.username FROM items i JOIN users u ON i.${USER_ID} = u.${USER_ID} WHERE i.${ITEM_ID} = $1 AND (i.is_deleted IS NULL OR i.is_deleted = FALSE)`,
    [item_id],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    user: { user_id: row.user_id as string, username: row.username },
    item: new ItemModel(row).toJSON(),
  };
};

/** Columns an item conflict may rewrite. `Table.upsert` otherwise defaults to
 *  every supplied key, which lets a colliding `item_id` reassign the row's
 *  owner. */
const ITEM_UPDATE_COLUMNS = [
  ACCESS_TOKEN,
  INSTITUTION_ID,
  AVAILABLE_PRODUCTS,
  CURSOR,
  STATUS,
  STATUS_REASON,
  PROVIDER,
  LAST_SYNC_STATUS,
  LAST_SYNC_AT,
  LAST_SYNC_ERROR,
  RAW,
];

export const upsertItems = async (
  user: MaskedUser,
  items: PartialItem[],
  client?: QueryExecutor,
): Promise<UpsertResult[]> => {
  if (!items.length) return [];
  const results: UpsertResult[] = [];

  for (const item of items) {
    try {
      const row = ItemModel.fromJSON(item, user.user_id);
      await itemsTable.upsert(row, ITEM_UPDATE_COLUMNS, client);
      results.push(successResult(item.item_id, 1));
    } catch (error) {
      logger.error("Failed to upsert item", { itemId: item.item_id }, error);
      results.push(errorResult(item.item_id));
    }
  }
  return results;
};

export const updateItemStatus = async (
  user: MaskedUser,
  item_id: string,
  status: string,
  status_reason?: string,
): Promise<boolean> => {
  const updated = await itemsTable.update(
    item_id,
    { status, status_reason: status_reason ?? null },
    undefined,
    user.user_id,
  );
  return updated !== null;
};

export interface SyncResult {
  success: boolean;
  error?: string;
}

export const updateItemSyncStatus = async (
  item_id: string,
  result: SyncResult,
): Promise<boolean> => {
  const updated = await itemsTable.update(item_id, {
    last_sync_status: result.success ? "success" : "failed",
    last_sync_at: new Date().toISOString(),
    last_sync_error: result.error ?? null,
  });
  return updated !== null;
};

export const deleteItem = async (user: MaskedUser, item_id: string): Promise<boolean> => {
  const { user_id } = user;

  const accounts = await accountsTable.query({ [ITEM_ID]: item_id, [USER_ID]: user_id });
  const accountIds = accounts.map((a) => a.account_id);

  return withTransaction(async (client) => {
    // Batch each cascade over all of the item's accounts in one round-trip
    // (`column = ANY($1)`) instead of 6 queries per account.
    // bulkSoftDeleteByColumn short-circuits an empty array, so no guard needed.
    await transactionsTable.bulkSoftDeleteByColumn(ACCOUNT_ID, accountIds, user_id, client);
    await investmentTransactionsTable.bulkSoftDeleteByColumn(
      ACCOUNT_ID,
      accountIds,
      user_id,
      client,
    );
    await splitTransactionsTable.bulkSoftDeleteByColumn(ACCOUNT_ID, accountIds, user_id, client);
    await softDeleteTransactionPairsByAccounts(user, accountIds, client);
    // Account-balance snapshots store the account in `account_id`; holding
    // snapshots store it in `holding_account_id` (their `account_id` is NULL).
    // Soft-delete both so removing an item leaves no orphaned holding history.
    await snapshotsTable.bulkSoftDeleteByColumn(ACCOUNT_ID, accountIds, user_id, client);
    await snapshotsTable.bulkSoftDeleteByColumn(HOLDING_ACCOUNT_ID, accountIds, user_id, client);
    await holdingsTable.bulkSoftDeleteByColumn(ACCOUNT_ID, accountIds, user_id, client);

    if (accountIds.length > 0) {
      await accountsTable.bulkSoftDelete(accountIds, { [USER_ID]: user_id }, client);
    }

    const deleted = await itemsTable.bulkSoftDelete([item_id], { [USER_ID]: user_id }, client);
    return deleted > 0;
  });
};

export const deleteItems = async (
  user: MaskedUser,
  item_ids: string[],
): Promise<{ deleted: number }> => {
  if (!item_ids.length) return { deleted: 0 };
  let deleted = 0;
  for (const id of item_ids) {
    if (await deleteItem(user, id)) deleted++;
  }
  return { deleted };
};
