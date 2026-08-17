import { randomUUID } from "node:crypto";

import { JSONAccount } from "common";
import type { AccountGraphOptions } from "common";
import {
  MaskedUser,
  AccountModel,
  accountsTable,
  transactionsTable,
  investmentTransactionsTable,
  splitTransactionsTable,
  snapshotsTable,
  holdingsTable,
  ACCOUNT_ID,
  HOLDING_ACCOUNT_ID,
  USER_ID,
  ITEM_ID,
  INSTITUTION_ID,
  QueryExecutor,
} from "../models";
import {
  UpsertResult,
  successResult,
  errorResult,
  noChangeResult,
} from "../database";
import { withTransaction } from "../client";
import { logger } from "../../logger";

export type PartialAccount = { account_id: string } & Partial<JSONAccount>;

export const getAccounts = async (user: MaskedUser): Promise<JSONAccount[]> => {
  const models = await accountsTable.query({ [USER_ID]: user.user_id });
  return models.map((m) => m.toJSON());
};

export const getAccount = async (
  user: MaskedUser,
  account_id: string,
): Promise<JSONAccount | null> => {
  const model = await accountsTable.queryOne({ [USER_ID]: user.user_id, [ACCOUNT_ID]: account_id });
  return model?.toJSON() ?? null;
};

export const getAccountsByItem = async (
  user: MaskedUser,
  item_id: string,
): Promise<JSONAccount[]> => {
  const models = await accountsTable.query({ [USER_ID]: user.user_id, [ITEM_ID]: item_id });
  return models.map((m) => m.toJSON());
};

export const searchAccountsByItemId = getAccountsByItem;

export const searchAccounts = async (
  user: MaskedUser,
  options: { account_id?: string; item_id?: string; institution_id?: string; type?: string } = {},
): Promise<JSONAccount[]> => {
  const filters: Record<string, unknown> = { [USER_ID]: user.user_id };
  if (options.account_id) filters[ACCOUNT_ID] = options.account_id;
  if (options.item_id) filters[ITEM_ID] = options.item_id;
  if (options.institution_id) filters[INSTITUTION_ID] = options.institution_id;
  if (options.type) filters.type = options.type;

  const models = await accountsTable.query(filters);
  return models.map((m) => m.toJSON());
};

export const searchAccountsById = async (
  user: MaskedUser,
  account_ids: string[],
): Promise<JSONAccount[]> => {
  if (!account_ids.length) return [];
  const models = await accountsTable.queryByIds(account_ids, { [USER_ID]: user.user_id });
  return models.map((m) => m.toJSON());
};

/**
 * Mint a shell `accounts` row for a manual item. The `account_id` is
 * server-generated (`manual-<uuid>`) so the FE never needs to invent
 * one — matches the `createManualTransaction` / `createManualInvestmentTransaction`
 * flow. Ownership and provider gating live at the route boundary
 * (`getNewAccountRoute`).
 */
export const createManualAccount = async (
  user: MaskedUser,
  input: { item_id: string; institution_id?: string; graphOptions?: AccountGraphOptions },
): Promise<JSONAccount | null> => {
  const account_id = `manual-${randomUUID()}`;
  const row = AccountModel.fromJSON(
    {
      account_id,
      item_id: input.item_id,
      institution_id: input.institution_id ?? "Unknown",
      name: "Unknown",
      type: "other",
      subtype: null,
      balances: {
        current: null,
        available: null,
        limit: null,
        iso_currency_code: null,
        unofficial_currency_code: null,
      },
      mask: null,
      official_name: null,
      graphOptions: input.graphOptions,
    } as unknown as JSONAccount,
    user.user_id,
  );
  // `raw` exists to hold a provider's payload; a manual account has none,
  // so `AccountModel.fromJSON` would fill it with a verbatim copy of the
  // caller-supplied init — unbounded, unvalidated, and a duplicate of the
  // columns written beside it.
  delete row.raw;
  try {
    const inserted = await accountsTable.insert(row, ["*"]);
    if (!inserted) return null;
    return new AccountModel(inserted).toJSON();
  } catch (error) {
    logger.error("Failed to create manual account", { account_id, item_id: input.item_id }, error);
    return null;
  }
};

export const upsertAccounts = async (
  user: MaskedUser,
  accounts: JSONAccount[],
  client?: QueryExecutor,
): Promise<UpsertResult[]> => {
  if (!accounts.length) return [];
  const results: UpsertResult[] = [];

  for (const account of accounts) {
    try {
      const row = AccountModel.fromJSON(account, user.user_id);
      await accountsTable.upsert(row, undefined, client);
      results.push(successResult(account.account_id, 1));
    } catch (error) {
      logger.error("Failed to upsert account", { accountId: account.account_id }, error);
      results.push(errorResult(account.account_id));
    }
  }
  return results;
};

export const updateAccounts = async (
  user: MaskedUser,
  accounts: PartialAccount[],
): Promise<UpsertResult[]> => {
  if (!accounts.length) return [];
  const results: UpsertResult[] = [];

  for (const account of accounts) {
    try {
      const row = AccountModel.fromJSON(account, user.user_id);
      delete row.account_id;
      delete row.user_id;
      // `institution_id` and `item_id` are create-only: an edit body naming
      // either would move an owned account between items or persist an
      // arbitrary institution string (neither column carries a foreign key).
      // `createManualAccount` is the sole writer of both — the mint route is
      // the only surface that can create or reparent.
      delete row.institution_id;
      delete row.item_id;

      // Soft-deleted rows keep their primary key but are invisible to every
      // read. Updating one would report a change no user can see; excluding
      // them here keeps "update" and "reachable" in agreement.
      const updated = await accountsTable.update(
        account.account_id,
        row,
        undefined,
        user.user_id,
        undefined,
        undefined,
        true,
      );
      results.push(
        updated ? successResult(account.account_id, 1) : noChangeResult(account.account_id),
      );
    } catch (error) {
      logger.error("Failed to update account", { accountId: account.account_id }, error);
      results.push(errorResult(account.account_id));
    }
  }
  return results;
};

export const deleteAccounts = async (
  user: MaskedUser,
  account_ids: string[],
): Promise<{ deleted: number }> => {
  if (!account_ids.length) return { deleted: 0 };
  const { user_id } = user;

  // Wrap all delete operations in a transaction for atomicity.
  // If any operation fails, all changes are rolled back.
  return withTransaction(async (client) => {
    for (const account_id of account_ids) {
      await transactionsTable.bulkSoftDeleteByColumn(ACCOUNT_ID, account_id, user_id, client);
      await investmentTransactionsTable.bulkSoftDeleteByColumn(
        ACCOUNT_ID,
        account_id,
        user_id,
        client,
      );
      await splitTransactionsTable.bulkSoftDeleteByColumn(ACCOUNT_ID, account_id, user_id, client);
      // Account-balance snapshots store the account in `account_id`; holding
      // snapshots store it in `holding_account_id` (their `account_id` is NULL).
      // Soft-delete both so deleting an account leaves no orphaned holding history.
      await snapshotsTable.bulkSoftDeleteByColumn(ACCOUNT_ID, account_id, user_id, client);
      await snapshotsTable.bulkSoftDeleteByColumn(HOLDING_ACCOUNT_ID, account_id, user_id, client);
      await holdingsTable.bulkSoftDeleteByColumn(ACCOUNT_ID, account_id, user_id, client);
    }

    const deleted = await accountsTable.bulkSoftDelete(account_ids, { [USER_ID]: user_id }, client);
    return { deleted };
  });
};
