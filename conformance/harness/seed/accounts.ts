/**
 * Connections (items), institutions, accounts and everything an account
 * holds, written straight to the database; a sharing group; and the stored
 * rows read back. For what no endpoint creates, and for asserting what a
 * request stored or deleted. Import from tests directly:
 *
 *   import { seedItem, seedAccount, shareData } from "../harness/seed/accounts";
 */
import type { Row } from "../postgres";
import type { Stack } from "../stack";

/** A row as plain JSON: a DATE as `YYYY-MM-DD`, a TIMESTAMPTZ as text, a NUMERIC as a number, JSONB as stored. */
export type StoredRow = Record<string, unknown>;

export type ItemProvider = "plaid" | "simple_fin" | "manual";

const PRIMARY_KEYS: Record<string, string> = {
  items: "item_id",
  institutions: "institution_id",
  accounts: "account_id",
  transactions: "transaction_id",
  investment_transactions: "investment_transaction_id",
  split_transactions: "split_transaction_id",
  transaction_pairs: "pair_id",
  snapshots: "snapshot_id",
  holdings: "holding_id",
  securities: "security_id",
  sharing_members: "user_id",
};

/** Every row of `table` matching `where` (equality per column), as plain JSON, in primary-key order. */
export const rowsOf = async (stack: Stack, table: string, where: Row = {}): Promise<StoredRow[]> => {
  const keys = Object.keys(where);
  const conditions = keys.map((key, i) => `t.${key} = $${i + 1}`);
  const rows = await stack.db.query<{ row: StoredRow }>(
    `SELECT to_jsonb(t) AS row FROM ${table} t${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY t.${PRIMARY_KEYS[table]}`,
    keys.map((key) => where[key]),
  );
  return rows.map(({ row }) => row);
};

/** The row of `table` whose primary key is `id`, as plain JSON; `undefined` when there is none. */
export const rowOf = async (stack: Stack, table: string, id: string): Promise<StoredRow | undefined> =>
  (await rowsOf(stack, table, { [PRIMARY_KEYS[table]]: id }))[0];

/** `is_deleted` of each row of `table` whose primary key is one of `ids`, by id; a missing row reads `"missing"`. */
export const deletedFlags = async (stack: Stack, table: string, ids: string[]): Promise<Record<string, unknown>> => {
  const flags: Record<string, unknown> = {};
  for (const id of ids) flags[id] = (await rowOf(stack, table, id))?.is_deleted ?? "missing";
  return flags;
};

const counters = new Map<string, number>();
/**
 * An id unique within the test process, for rows whose id the test does not
 * care about. It is the same on every run, so the two servers' transcripts
 * name the same rows.
 */
export const uniqueId = (prefix: string): string => {
  const next = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, next);
  return `${prefix}-${next}`;
};

/**
 * A connection. `provider` is required since it decides what every route may
 * do with the item; the rest defaults to a working item of that provider: a
 * Plaid access token, a SimpleFin access URL, nothing for a manual one.
 */
export const seedItem = async (stack: Stack, user_id: string, provider: ItemProvider, row: Row = {}): Promise<string> => {
  const item_id = (row.item_id as string | undefined) ?? uniqueId(`item-${provider}`);
  const access_token =
    provider === "plaid"
      ? `access-production-${crypto.randomUUID()}`
      : provider === "simple_fin"
        ? "https://user:secret@bridge.simplefin.test/simplefin"
        : null;
  await stack.db.insert("items", {
    item_id,
    user_id,
    access_token,
    institution_id: provider === "manual" ? null : "ins_109508",
    available_products: provider === "plaid" ? ["transactions"] : [],
    provider,
    status: "ok",
    ...row,
  });
  return item_id;
};

/** An institution as `upsertInstitutions` stores one: its id, its name, and what was given as `raw`. */
export const seedInstitution = async (stack: Stack, institution_id: string, row: Row = {}): Promise<void> => {
  const name = (row.name as string | undefined) ?? `Institution ${institution_id}`;
  await stack.db.insert("institutions", { institution_id, name, raw: { institution_id, name }, ...row });
};

/** An account of the item; a depository checking account with balances unless `row` says otherwise. */
export const seedAccount = async (stack: Stack, user_id: string, item_id: string, row: Row = {}): Promise<string> => {
  const account_id = (row.account_id as string | undefined) ?? uniqueId("acc");
  await stack.db.insert("accounts", {
    account_id,
    user_id,
    item_id,
    institution_id: "ins_109508",
    name: "Seeded Checking",
    type: "depository",
    subtype: "checking",
    balances_available: "100.5",
    balances_current: "110.25",
    balances_iso_currency_code: "USD",
    ...row,
  });
  return account_id;
};

export const seedTransaction = async (stack: Stack, user_id: string, account_id: string, row: Row = {}): Promise<string> => {
  const transaction_id = (row.transaction_id as string | undefined) ?? uniqueId("tx");
  await stack.db.insert("transactions", {
    transaction_id,
    user_id,
    account_id,
    name: "Seeded transaction",
    amount: "12.34",
    date: "2026-03-04",
    ...row,
  });
  return transaction_id;
};

export const seedInvestmentTransaction = async (stack: Stack, user_id: string, account_id: string, row: Row = {}): Promise<string> => {
  const investment_transaction_id = (row.investment_transaction_id as string | undefined) ?? uniqueId("inv");
  await stack.db.insert("investment_transactions", {
    investment_transaction_id,
    user_id,
    account_id,
    name: "Seeded investment transaction",
    amount: "100",
    quantity: "1",
    price: "100",
    date: "2026-03-04",
    type: "buy",
    subtype: "buy",
    ...row,
  });
  return investment_transaction_id;
};

export const seedSplitTransaction = async (
  stack: Stack,
  user_id: string,
  transaction_id: string,
  account_id: string,
  row: Row = {},
): Promise<string> =>
  (
    await stack.db.insert<{ split_transaction_id: string }>("split_transactions", {
      user_id,
      transaction_id,
      account_id,
      amount: "5",
      date: "2026-03-04",
      ...row,
    })
  ).split_transaction_id;

/** A transfer pair of two transactions, confirmed unless `row` says otherwise. */
export const seedTransactionPair = async (
  stack: Stack,
  user_id: string,
  transaction_id_a: string,
  transaction_id_b: string,
  row: Row = {},
): Promise<string> => {
  const pair_id = (row.pair_id as string | undefined) ?? crypto.randomUUID();
  await stack.db.insert("transaction_pairs", { pair_id, user_id, transaction_id_a, transaction_id_b, status: "confirmed", ...row });
  return pair_id;
};

/** A balance snapshot of an account. */
export const seedAccountSnapshot = async (stack: Stack, user_id: string, account_id: string, row: Row = {}): Promise<string> => {
  const snapshot_id = (row.snapshot_id as string | undefined) ?? uniqueId("snap");
  await stack.db.insert("snapshots", {
    snapshot_id,
    user_id,
    snapshot_date: "2026-03-04",
    snapshot_type: "account_balance",
    account_id,
    balances_current: "110.25",
    balances_iso_currency_code: "USD",
    ...row,
  });
  return snapshot_id;
};

/** A snapshot of a holding of the account: it names the account in `holding_account_id`, not `account_id`. */
export const seedHoldingSnapshot = async (
  stack: Stack,
  user_id: string,
  account_id: string,
  security_id: string,
  row: Row = {},
): Promise<string> => {
  const snapshot_id = (row.snapshot_id as string | undefined) ?? uniqueId("snap-holding");
  await stack.db.insert("snapshots", {
    snapshot_id,
    user_id,
    snapshot_date: "2026-03-04",
    snapshot_type: "holding",
    holding_account_id: account_id,
    holding_security_id: security_id,
    institution_price: "10",
    institution_value: "100",
    cost_basis: "90",
    quantity: "10",
    ...row,
  });
  return snapshot_id;
};

export const seedSecurity = async (stack: Stack, security_id: string, row: Row = {}): Promise<void> => {
  await stack.db.insert("securities", {
    security_id,
    name: `Security ${security_id}`,
    ticker_symbol: "SEED",
    type: "etf",
    close_price: "10",
    close_price_as_of: "2026-03-04",
    iso_currency_code: "USD",
    ...row,
  });
};

/** A holding of a security in the account; its id is `<account_id>-<security_id>` unless given. */
export const seedHolding = async (stack: Stack, user_id: string, account_id: string, security_id: string, row: Row = {}): Promise<string> => {
  const holding_id = (row.holding_id as string | undefined) ?? `${account_id}-${security_id}`;
  await stack.db.insert("holdings", {
    holding_id,
    user_id,
    account_id,
    security_id,
    institution_price: "10",
    institution_price_as_of: "2026-03-04",
    institution_value: "100",
    cost_basis: "90",
    quantity: "10",
    iso_currency_code: "USD",
    ...row,
  });
  return holding_id;
};

/**
 * Puts the users in one sharing group, as accepting an invitation does: from
 * then on each reads and writes every other's data. Returns the group id.
 */
export const shareData = async (stack: Stack, ...user_ids: string[]): Promise<string> => {
  const group_id = crypto.randomUUID();
  for (const user_id of user_ids) await stack.db.insert("sharing_members", { user_id, group_id });
  return group_id;
};

/** Takes the users out of whatever sharing group they are in. */
export const stopSharing = async (stack: Stack, ...user_ids: string[]): Promise<void> => {
  await stack.db.query("DELETE FROM sharing_members WHERE user_id = ANY($1::uuid[])", [user_ids]);
};

export const softDeleteRow = async (stack: Stack, table: string, id: string): Promise<void> => {
  await stack.db.query(`UPDATE ${table} SET is_deleted = TRUE WHERE ${PRIMARY_KEYS[table]} = $1`, [id]);
};
