/**
 * Budgets, sections, categories, charts, CPI months, the rows that carry a
 * budget or category as their label, and an API key, written straight to the
 * database; and the stored rows read back. For what no endpoint creates, and
 * for asserting what a request stored.
 */
import type { Row } from "../postgres";
import type { Stack } from "../stack";

/** The series `GET /inflation` averages: CPI-U, all items, not seasonally adjusted. */
export const CPI_SERIES_ID = "CUUR0000SA0";

/** A row as plain JSON: a DATE as `YYYY-MM-DD`, a TIMESTAMPTZ as text, a NUMERIC as a number, JSONB as stored. */
export type StoredRow = Record<string, unknown>;

const PRIMARY_KEYS: Record<string, string> = {
  budgets: "budget_id",
  sections: "section_id",
  categories: "category_id",
  charts: "chart_id",
  cpi_snapshots: "cpi_snapshot_id",
  accounts: "account_id",
  transactions: "transaction_id",
  split_transactions: "split_transaction_id",
  investment_transactions: "investment_transaction_id",
  recurrings: "recurring_id",
};

/** Every row of `table` matching `where`, as plain JSON, in primary-key order. */
export const storedRows = async (stack: Stack, table: string, where: Row = {}): Promise<StoredRow[]> => {
  const keys = Object.keys(where);
  const conditions = keys.map((key, i) => `t.${key} = $${i + 1}`);
  const rows = await stack.db.query<{ row: StoredRow }>(
    `SELECT to_jsonb(t) AS row FROM ${table} t${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY t.${PRIMARY_KEYS[table]}`,
    keys.map((key) => where[key]),
  );
  return rows.map(({ row }) => row);
};

/** The row of `table` whose primary key is `id`, as plain JSON; `undefined` when there is none. */
export const storedRow = async (stack: Stack, table: string, id: string): Promise<StoredRow | undefined> =>
  (await storedRows(stack, table, { [PRIMARY_KEYS[table]]: id }))[0];

/**
 * Whether `after` was written later than `before`, by the rows' `updated`.
 * Both are the database's own text for the column, to the microsecond and in
 * one time zone, so they compare as text.
 */
export const updatedLater = (after: StoredRow, before: StoredRow): boolean => String(after.updated) > String(before.updated);

/**
 * Sets a JSONB column to exactly `json`, written into the statement as a
 * literal so a scalar (`"text"`, `5`, `true`) is stored as that scalar.
 */
export const setJsonb = async (stack: Stack, table: string, id: string, column: string, json: string): Promise<void> => {
  await stack.db.query(`UPDATE ${table} SET ${column} = '${json.replace(/'/g, "''")}'::jsonb WHERE ${PRIMARY_KEYS[table]} = $1`, [id]);
};

export const softDelete = async (stack: Stack, table: string, id: string): Promise<void> => {
  await stack.db.query(`UPDATE ${table} SET is_deleted = TRUE WHERE ${PRIMARY_KEYS[table]} = $1`, [id]);
};

export const seedBudget = async (stack: Stack, user_id: string, row: Row = {}): Promise<string> =>
  (await stack.db.insert<{ budget_id: string }>("budgets", { user_id, name: "Seeded budget", capacities: [], ...row })).budget_id;

export const seedSection = async (stack: Stack, user_id: string, budget_id: string, row: Row = {}): Promise<string> =>
  (await stack.db.insert<{ section_id: string }>("sections", { user_id, budget_id, name: "Seeded section", capacities: [], ...row }))
    .section_id;

export const seedCategory = async (stack: Stack, user_id: string, section_id: string, row: Row = {}): Promise<string> =>
  (
    await stack.db.insert<{ category_id: string }>("categories", {
      user_id,
      section_id,
      name: "Seeded category",
      capacities: [],
      ...row,
    })
  ).category_id;

export const seedChart = async (stack: Stack, user_id: string, row: Row = {}): Promise<string> =>
  (
    await stack.db.insert<{ chart_id: string }>("charts", {
      user_id,
      name: "Seeded chart",
      type: "balance_chart",
      configuration: {},
      ...row,
    })
  ).chart_id;

/** One stored CPI month. `date` is `YYYY-MM-DD`; the id is the one the refresh derives, unless given. */
export const seedCpi = async (
  stack: Stack,
  date: string,
  value: number | string,
  { series_id = CPI_SERIES_ID, id = `${series_id}-${date.slice(0, 7)}` }: { series_id?: string; id?: string } = {},
): Promise<void> => {
  await stack.db.query(
    "INSERT INTO cpi_snapshots (cpi_snapshot_id, series_id, snapshot_date, index_value) VALUES ($1, $2, $3::date, $4::numeric)",
    [id, series_id, date, String(value)],
  );
};

export interface Label {
  budget_id?: string | null;
  category_id?: string | null;
}

export interface LabeledRows {
  account_id: string;
  transaction_id: string;
  split_transaction_id: string;
  investment_transaction_id: string;
  recurring_id: string;
}

/**
 * One row of every table that can name a budget or a category as its label:
 * an account, a transaction, a split of it, an investment transaction and a
 * recurring, all the user's and all labeled with `label`; plus a rejection of
 * the category for the transaction, when there is a category.
 */
export const seedLabeledRows = async (stack: Stack, user_id: string, tag: string, label: Label): Promise<LabeledRows> => {
  const { budget_id = null, category_id = null } = label;
  const ids: LabeledRows = {
    account_id: `acc-${tag}`,
    transaction_id: `tx-${tag}`,
    split_transaction_id: crypto.randomUUID(),
    investment_transaction_id: `inv-${tag}`,
    recurring_id: crypto.randomUUID(),
  };
  await stack.db.insert("accounts", {
    account_id: ids.account_id,
    user_id,
    item_id: `item-${tag}`,
    institution_id: `ins-${tag}`,
    name: `Account ${tag}`,
    label_budget_id: budget_id,
  });
  await stack.db.insert("transactions", {
    transaction_id: ids.transaction_id,
    user_id,
    account_id: ids.account_id,
    name: `Transaction ${tag}`,
    amount: "12.34",
    date: "2026-03-04",
    label_budget_id: budget_id,
    label_category_id: category_id,
  });
  await stack.db.insert("split_transactions", {
    split_transaction_id: ids.split_transaction_id,
    user_id,
    transaction_id: ids.transaction_id,
    account_id: ids.account_id,
    amount: "5",
    date: "2026-03-04",
    label_budget_id: budget_id,
    label_category_id: category_id,
  });
  await stack.db.insert("investment_transactions", {
    investment_transaction_id: ids.investment_transaction_id,
    user_id,
    account_id: ids.account_id,
    date: "2026-03-04",
    label_budget_id: budget_id,
    label_category_id: category_id,
  });
  await stack.db.insert("recurrings", {
    recurring_id: ids.recurring_id,
    user_id,
    merchant_key: `merchant-${tag}`,
    merchant_name: `Merchant ${tag}`,
    cadence: "monthly",
    is_income: false,
    status: "confirmed",
    label_budget_id: budget_id,
    label_category_id: category_id,
  });
  if (category_id) {
    await stack.db.insert("rejected_categories", { transaction_id: ids.transaction_id, user_id, category_id });
  }
  return ids;
};

/** The label columns of every row `seedLabeledRows` wrote, and the rejections of the transaction. */
export const storedLabels = async (stack: Stack, ids: LabeledRows): Promise<Record<string, unknown>> => {
  const pick = (row: StoredRow | undefined, columns: string[]) =>
    row && Object.fromEntries(["is_deleted", ...columns].map((column) => [column, row[column]]));
  const both = ["label_budget_id", "label_category_id"];
  return {
    account: pick(await storedRow(stack, "accounts", ids.account_id), ["label_budget_id"]),
    transaction: pick(await storedRow(stack, "transactions", ids.transaction_id), both),
    split: pick(await storedRow(stack, "split_transactions", ids.split_transaction_id), both),
    investment: pick(await storedRow(stack, "investment_transactions", ids.investment_transaction_id), both),
    recurring: pick(await storedRow(stack, "recurrings", ids.recurring_id), both),
    rejected: (await stack.db.rows("rejected_categories", { transaction_id: ids.transaction_id })).map((row) => row.category_id),
  };
};

/**
 * Stores a live API key for the user, holding `scopes`, and returns its
 * plaintext: what a caller sends as `Authorization: Bearer …`. Only the
 * SHA-256 of a key is stored, as the server stores it.
 */
export const seedApiKey = async (stack: Stack, user_id: string, scopes: string[]): Promise<string> => {
  const plaintext = `bk_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
  await stack.db.insert("api_keys", {
    user_id,
    name: "Seeded key",
    key_hash: new Bun.CryptoHasher("sha256").update(plaintext).digest("hex"),
    key_prefix: plaintext.slice(0, 11),
    scopes,
  });
  return plaintext;
};

/**
 * While `run` runs, an insert into `table` stores no row and reports none,
 * the one way a create can come back empty without failing.
 */
export const withInsertsDropped = async <T>(stack: Stack, table: string, run: () => Promise<T>): Promise<T> => {
  await stack.db.query(
    "CREATE OR REPLACE FUNCTION conformance_drop_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$",
  );
  await stack.db.query(
    `CREATE TRIGGER conformance_drop_insert BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION conformance_drop_row()`,
  );
  try {
    return await run();
  } finally {
    await stack.db.query(`DROP TRIGGER conformance_drop_insert ON ${table}`);
  }
};
