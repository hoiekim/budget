import { JSONAccount } from "common";
import {
  MaskedUser, AccountModel, accountsTable,
  ACCOUNT_ID, USER_ID, ITEM_ID, INSTITUTION_ID,
  TRANSACTIONS, INVESTMENT_TRANSACTIONS, SPLIT_TRANSACTIONS, SNAPSHOTS,
} from "../models";
import { pool } from "../client";
import { UpsertResult, successResult, errorResult, noChangeResult } from "../database";

export type PartialAccount = { account_id: string } & Partial<JSONAccount>;

export const getAccounts = async (user: MaskedUser): Promise<JSONAccount[]> => {
  const models = await accountsTable.query({ [USER_ID]: user.user_id });
  return models.map(m => m.toJSON());
};

export const getAccount = async (user: MaskedUser, account_id: string): Promise<JSONAccount | null> => {
  const model = await accountsTable.queryOne({ [USER_ID]: user.user_id, [ACCOUNT_ID]: account_id });
  return model?.toJSON() ?? null;
};

export const getAccountsByItem = async (user: MaskedUser, item_id: string): Promise<JSONAccount[]> => {
  const models = await accountsTable.query({ [USER_ID]: user.user_id, [ITEM_ID]: item_id });
  return models.map(m => m.toJSON());
};

export const searchAccountsByItemId = getAccountsByItem;

export const searchAccounts = async (
  user: MaskedUser,
  options: { account_id?: string; item_id?: string; institution_id?: string; type?: string } = {}
): Promise<JSONAccount[]> => {
  const filters: Record<string, unknown> = { [USER_ID]: user.user_id };
  if (options.account_id) filters[ACCOUNT_ID] = options.account_id;
  if (options.item_id) filters[ITEM_ID] = options.item_id;
  if (options.institution_id) filters[INSTITUTION_ID] = options.institution_id;
  if (options.type) filters.type = options.type;
  
  const models = await accountsTable.query(filters);
  return models.map(m => m.toJSON());
};

export const searchAccountsById = async (user: MaskedUser, account_ids: string[]): Promise<JSONAccount[]> => {
  if (!account_ids.length) return [];
  const placeholders = account_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM accounts WHERE ${ACCOUNT_ID} IN (${placeholders}) AND ${USER_ID} = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user.user_id, ...account_ids]
  );
  return result.rows.map(row => new AccountModel(row).toJSON());
};

export const upsertAccounts = async (user: MaskedUser, accounts: JSONAccount[]): Promise<UpsertResult[]> => {
  if (!accounts.length) return [];
  const results: UpsertResult[] = [];

  for (const account of accounts) {
    try {
      const row = AccountModel.toRow(account, user.user_id);
      await accountsTable.upsert(row);
      results.push(successResult(account.account_id, 1));
    } catch (error) {
      console.error(`Failed to upsert account ${account.account_id}:`, error);
      results.push(errorResult(account.account_id));
    }
  }
  return results;
};

export const updateAccounts = async (user: MaskedUser, accounts: PartialAccount[]): Promise<UpsertResult[]> => {
  if (!accounts.length) return [];
  const results: UpsertResult[] = [];

  for (const account of accounts) {
    try {
      const row = AccountModel.toRow(account, user.user_id);
      delete row.account_id;
      delete row.user_id;
      
      const updated = await accountsTable.update(account.account_id, row);
      results.push(updated ? successResult(account.account_id, 1) : noChangeResult(account.account_id));
    } catch (error) {
      console.error(`Failed to update account ${account.account_id}:`, error);
      results.push(errorResult(account.account_id));
    }
  }
  return results;
};

export const deleteAccounts = async (user: MaskedUser, account_ids: string[]): Promise<{ deleted: number }> => {
  if (!account_ids.length) return { deleted: 0 };
  const { user_id } = user;
  const placeholders = account_ids.map((_, i) => `$${i + 2}`).join(", ");

  await pool.query(
    `UPDATE ${TRANSACTIONS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE ${ACCOUNT_ID} IN (${placeholders}) AND ${USER_ID} = $1`,
    [user_id, ...account_ids]
  );
  await pool.query(
    `UPDATE ${INVESTMENT_TRANSACTIONS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE ${ACCOUNT_ID} IN (${placeholders}) AND ${USER_ID} = $1`,
    [user_id, ...account_ids]
  );
  await pool.query(
    `UPDATE ${SPLIT_TRANSACTIONS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE ${ACCOUNT_ID} IN (${placeholders}) AND ${USER_ID} = $1`,
    [user_id, ...account_ids]
  );
  await pool.query(
    `UPDATE ${SNAPSHOTS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE ${ACCOUNT_ID} IN (${placeholders}) AND ${USER_ID} = $1`,
    [user_id, ...account_ids]
  );

  const result = await pool.query(
    `UPDATE accounts SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE ${ACCOUNT_ID} IN (${placeholders}) AND ${USER_ID} = $1 RETURNING ${ACCOUNT_ID}`,
    [user_id, ...account_ids]
  );
  return { deleted: result.rowCount ?? 0 };
};

export const deleteAccountsByItem = async (user: MaskedUser, item_id: string): Promise<{ deleted: number }> => {
  const accounts = await getAccountsByItem(user, item_id);
  if (!accounts.length) return { deleted: 0 };
  return deleteAccounts(user, accounts.map(a => a.account_id));
};
