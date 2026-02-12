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
  INSTITUTION_ID,
  ACCOUNT_ID,
} from "../models";
import { pool } from "../client";
import { UpsertResult, successResult, errorResult, noChangeResult } from "../database";

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

export const upsertItems = async (
  user: MaskedUser,
  items: PartialItem[],
  upsert: boolean = true,
): Promise<UpsertResult[]> => {
  if (!items.length) return [];
  const results: UpsertResult[] = [];

  for (const item of items) {
    try {
      const row = ItemModel.fromJSON(item, user.user_id);
      if (upsert) {
        await itemsTable.upsert(row);
        results.push(successResult(item.item_id, 1));
      } else {
        delete row.item_id;
        delete row.user_id;
        const updated = await itemsTable.update(item.item_id, row);
        results.push(updated ? successResult(item.item_id, 1) : noChangeResult(item.item_id));
      }
    } catch (error) {
      console.error(`Failed to upsert item ${item.item_id}:`, error);
      results.push(errorResult(item.item_id));
    }
  }
  return results;
};

export const updateItemCursor = async (item_id: string, cursor: string): Promise<boolean> => {
  const updated = await itemsTable.update(item_id, { cursor });
  return updated !== null;
};

export const updateItemStatus = async (item_id: string, status: string): Promise<boolean> => {
  const updated = await itemsTable.update(item_id, { status });
  return updated !== null;
};

export const deleteItem = async (user: MaskedUser, item_id: string): Promise<boolean> => {
  const { user_id } = user;

  const accounts = await accountsTable.query({ [ITEM_ID]: item_id, [USER_ID]: user_id });
  const accountIds = accounts.map((a) => a.account_id);

  for (const account_id of accountIds) {
    await transactionsTable.bulkSoftDeleteByColumn(ACCOUNT_ID, account_id, user_id);
    await investmentTransactionsTable.bulkSoftDeleteByColumn(ACCOUNT_ID, account_id, user_id);
    await splitTransactionsTable.bulkSoftDeleteByColumn(ACCOUNT_ID, account_id, user_id);
    await snapshotsTable.bulkSoftDeleteByColumn(ACCOUNT_ID, account_id, user_id);
    await holdingsTable.bulkSoftDeleteByColumn(ACCOUNT_ID, account_id, user_id);
    await accountsTable.softDelete(account_id);
  }

  return await itemsTable.softDelete(item_id);
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
