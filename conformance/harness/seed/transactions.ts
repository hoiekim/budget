/**
 * Items, accounts, securities, transactions, their splits, investment
 * transactions, category rejections and sharing groups, written straight to
 * the database; and what the API answers for a stored row. For what no
 * endpoint creates, and for asserting what a request stored.
 */
import type { Row } from "../postgres";
import type { Stack } from "../stack";
import { storedRow, type StoredRow } from "./budgets";

let counter = 0;
/** A short id no other seeded row has, with a readable prefix. */
export const uniqueId = (prefix: string): string => `${prefix}-${++counter}`;

/** `YYYY-MM-DD` of the local day `offset` days from today: how the servers' local-time code sees dates. */
export const localDay = (offset = 0): string => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** Today's UTC date, `new Date().toISOString().split("T")[0]`: the date a minted row gets. */
export const utcToday = (): string => new Date().toISOString().split("T")[0];

/** Puts the users in one sharing group, as accepting an invitation does. Returns the group id. */
export const shareData = async (stack: Stack, ...user_ids: string[]): Promise<string> => {
  const group_id = crypto.randomUUID();
  for (const user_id of user_ids) await stack.db.insert("sharing_members", { user_id, group_id });
  return group_id;
};

export const seedItem = async (stack: Stack, user_id: string, row: Row = {}): Promise<string> =>
  (
    await stack.db.insert<{ item_id: string }>("items", {
      item_id: uniqueId("item"),
      user_id,
      institution_id: "ins-seeded",
      provider: "manual",
      ...row,
    })
  ).item_id;

/** An account, under a manual item of its own unless `item_id` is given. */
export const seedAccount = async (stack: Stack, user_id: string, row: Row = {}): Promise<string> => {
  const item_id = (row.item_id as string | undefined) ?? (await seedItem(stack, user_id));
  return (
    await stack.db.insert<{ account_id: string }>("accounts", {
      account_id: uniqueId("acc"),
      user_id,
      item_id,
      institution_id: "ins-seeded",
      name: "Seeded account",
      type: "depository",
      ...row,
    })
  ).account_id;
};

export const seedTransaction = async (stack: Stack, user_id: string, row: Row = {}): Promise<string> =>
  (
    await stack.db.insert<{ transaction_id: string }>("transactions", {
      transaction_id: uniqueId("tx"),
      user_id,
      account_id: "acc-unseeded",
      name: "Seeded transaction",
      amount: "10",
      date: "2026-03-04",
      ...row,
    })
  ).transaction_id;

export const seedSplit = async (stack: Stack, user_id: string, row: Row = {}): Promise<string> =>
  (
    await stack.db.insert<{ split_transaction_id: string }>("split_transactions", {
      user_id,
      transaction_id: "tx-unseeded",
      account_id: "acc-unseeded",
      amount: "5",
      date: "2026-03-04",
      ...row,
    })
  ).split_transaction_id;

export const seedInvestmentTransaction = async (stack: Stack, user_id: string, row: Row = {}): Promise<string> =>
  (
    await stack.db.insert<{ investment_transaction_id: string }>("investment_transactions", {
      investment_transaction_id: uniqueId("inv"),
      user_id,
      account_id: "acc-unseeded",
      date: "2026-03-04",
      ...row,
    })
  ).investment_transaction_id;

export const seedSecurity = async (stack: Stack, row: Row = {}): Promise<string> =>
  (await stack.db.insert<{ security_id: string }>("securities", { security_id: uniqueId("sec"), name: "Seeded security", ...row }))
    .security_id;

export const seedRejection = async (stack: Stack, user_id: string, transaction_id: string, category_id: string): Promise<void> => {
  await stack.db.insert("rejected_categories", { transaction_id, user_id, category_id });
};

/** A budget, a section in it and a category in that, all the user's. */
export const seedCategoryTree = async (
  stack: Stack,
  user_id: string,
): Promise<{ budget_id: string; section_id: string; category_id: string }> => {
  const { budget_id } = await stack.db.insert<{ budget_id: string }>("budgets", { user_id, name: "Tree budget", capacities: [] });
  const { section_id } = await stack.db.insert<{ section_id: string }>("sections", {
    user_id,
    budget_id,
    name: "Tree section",
    capacities: [],
  });
  const { category_id } = await stack.db.insert<{ category_id: string }>("categories", {
    user_id,
    section_id,
    name: "Tree category",
    capacities: [],
  });
  return { budget_id, section_id, category_id };
};

const need = (row: StoredRow | undefined, what: string): StoredRow => {
  if (!row) throw new Error(`no ${what}`);
  return row;
};

export const storedTransaction = async (stack: Stack, id: string): Promise<StoredRow> =>
  need(await storedRow(stack, "transactions", id), `transaction ${id}`);
export const storedSplit = async (stack: Stack, id: string): Promise<StoredRow> =>
  need(await storedRow(stack, "split_transactions", id), `split transaction ${id}`);
export const storedInvestmentTransaction = async (stack: Stack, id: string): Promise<StoredRow> =>
  need(await storedRow(stack, "investment_transactions", id), `investment transaction ${id}`);

/** The rejections stored for a transaction, as `[user_id, category_id]` pairs. */
export const storedRejections = async (stack: Stack, transaction_id: string): Promise<[string, string][]> =>
  (await stack.db.rows<{ user_id: string; category_id: string }>("rejected_categories", { transaction_id }, "category_id")).map(
    (row) => [row.user_id, row.category_id],
  );

/** What the API answers for a stored transaction: a `JSONTransaction`. */
export const transactionJson = (row: StoredRow): Record<string, unknown> => ({
  transaction_id: row.transaction_id,
  account_id: row.account_id,
  name: row.name,
  merchant_name: row.merchant_name,
  amount: row.amount,
  iso_currency_code: row.iso_currency_code,
  date: row.date,
  pending: row.pending,
  pending_transaction_id: row.pending_transaction_id,
  payment_channel: row.payment_channel,
  label: {
    budget_id: row.label_budget_id,
    category_id: row.label_category_id,
    memo: row.label_memo,
    category_confidence: row.label_category_confidence,
  },
  location: {
    address: null,
    city: row.location_city,
    region: row.location_region,
    postal_code: null,
    country: row.location_country,
    store_number: null,
    lat: null,
    lon: null,
  },
  payment_meta: {
    reference_number: null,
    ppd_id: null,
    payee: null,
    by_order_of: null,
    payer: null,
    payment_method: null,
    payment_processor: null,
    reason: null,
  },
  category_id: null,
  category: null,
  account_owner: null,
  unofficial_currency_code: null,
  authorized_date: null,
  authorized_datetime: null,
  datetime: null,
  transaction_code: null,
  is_deleted: row.is_deleted ?? false,
  source: row.source ?? "plaid",
});

/** What the API answers for a stored split transaction. */
export const splitJson = (row: StoredRow): Record<string, unknown> => {
  const json: Record<string, unknown> = {
    split_transaction_id: row.split_transaction_id,
    transaction_id: row.transaction_id,
    account_id: row.account_id,
    amount: row.amount,
  };
  if (row.date) json.date = row.date;
  json.custom_name = row.custom_name;
  json.label = {
    budget_id: row.label_budget_id,
    category_id: row.label_category_id,
    memo: row.label_memo,
    category_confidence: row.label_category_confidence,
  };
  json.is_deleted = row.is_deleted ?? false;
  return json;
};

/** What the API answers for a stored investment transaction. */
export const investmentJson = (row: StoredRow): Record<string, unknown> => ({
  investment_transaction_id: row.investment_transaction_id,
  account_id: row.account_id,
  security_id: row.security_id,
  date: row.date,
  name: row.name,
  quantity: row.quantity,
  amount: row.amount,
  price: row.price,
  iso_currency_code: row.iso_currency_code,
  type: row.type,
  subtype: row.subtype,
  fees: null,
  unofficial_currency_code: null,
  label: { budget_id: row.label_budget_id, category_id: row.label_category_id, memo: row.label_memo },
  is_deleted: row.is_deleted ?? false,
  source: row.source ?? "plaid",
});

/**
 * While `run` runs, an UPDATE of `table` changes no row and reports none,
 * the way a row changed by someone else between a read and a write would.
 */
export const withUpdatesDropped = async <T>(stack: Stack, table: string, run: () => Promise<T>): Promise<T> => {
  await stack.db.query(
    "CREATE OR REPLACE FUNCTION conformance_drop_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$",
  );
  await stack.db.query(
    `CREATE TRIGGER conformance_drop_update BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION conformance_drop_row()`,
  );
  try {
    return await run();
  } finally {
    await stack.db.query(`DROP TRIGGER conformance_drop_update ON ${table}`);
  }
};

/** Soft-deletes the row of `table` whose `column` is `id`. */
export const softDeleteWhere = async (stack: Stack, table: string, column: string, id: string): Promise<void> => {
  await stack.db.query(`UPDATE ${table} SET is_deleted = TRUE WHERE ${column} = $1`, [id]);
};

/** Sets the `updated` column of a row to an exact instant. */
export const setUpdated = async (stack: Stack, table: string, column: string, id: string, iso: string): Promise<void> => {
  await stack.db.query(`UPDATE ${table} SET updated = $2::timestamptz WHERE ${column} = $1`, [id, iso]);
};
