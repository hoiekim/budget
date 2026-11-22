/**
 * Accounts, transactions, transfer pairs, recurrings and sharing groups,
 * written straight to the database; the stored rows read back; and the JSON
 * shapes the transfer and recurring routes answer with. For the routes'
 * tests, and for the detection jobs, which have no route: a test seeds what
 * the boot-time sync should find, restarts the server, and reads what the job
 * stored and logged.
 */
import type { Row } from "../postgres";
import type { Stack } from "../stack";

export type StoredRow = Record<string, unknown>;

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` of the local day `days` from today, as the servers compute local dates. */
export const localDay = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/**
 * `YYYY-MM-DD` of the calendar day `days` from today's UTC date: the "today"
 * the recurring detector measures lapses from (`new Date().toISOString()`).
 */
export const utcDay = (days: number): string => {
  const today = new Date().toISOString().slice(0, 10);
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** A well-formed UUID no row has. */
export const NO_SUCH_UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An ISO timestamp as both servers write one: milliseconds and `Z`. */
export const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const seedAccount = async (stack: Stack, user_id: string, account_id: string, row: Row = {}): Promise<string> => {
  await stack.db.insert("accounts", {
    account_id,
    user_id,
    item_id: `item-${account_id}`,
    institution_id: "ins-seeded",
    name: `Account ${account_id}`,
    ...row,
  });
  return account_id;
};

export interface SeedTransaction {
  transaction_id: string;
  account_id: string;
  amount: number | null;
  date: string;
  name?: string | null;
  merchant_name?: string | null;
  pending?: boolean | null;
  is_deleted?: boolean | null;
  label_budget_id?: string | null;
  label_category_id?: string | null;
  label_memo?: string | null;
  label_category_confidence?: number | null;
  raw?: unknown;
}

/** One transaction of `user_id`. The amount follows Plaid: positive is money out. */
export const seedTransaction = async (stack: Stack, user_id: string, tx: SeedTransaction): Promise<SeedTransaction> => {
  await stack.db.insert("transactions", {
    ...tx,
    user_id,
    amount: tx.amount === null ? null : String(tx.amount),
    name: tx.name === undefined ? `Transaction ${tx.transaction_id}` : tx.name,
  });
  return tx;
};

/**
 * The `JSONTransaction` both servers answer with for a transaction seeded with
 * `tx`: what no column holds is `null`.
 */
export const transactionJson = (tx: SeedTransaction): { transaction_id: string } & Record<string, unknown> => ({
  transaction_id: tx.transaction_id,
  account_id: tx.account_id,
  name: tx.name === undefined ? `Transaction ${tx.transaction_id}` : tx.name,
  merchant_name: tx.merchant_name ?? null,
  amount: tx.amount,
  iso_currency_code: null,
  date: tx.date,
  pending: tx.pending === undefined ? false : tx.pending,
  pending_transaction_id: null,
  payment_channel: null,
  label: {
    budget_id: tx.label_budget_id ?? null,
    category_id: tx.label_category_id ?? null,
    memo: tx.label_memo ?? null,
    category_confidence: tx.label_category_confidence ?? null,
  },
  location: {
    address: null,
    city: null,
    region: null,
    postal_code: null,
    country: null,
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
  is_deleted: tx.is_deleted ?? false,
  source: "plaid",
});

/** A transfer pair owned by `user_id`; its id is returned. */
export const seedPair = async (
  stack: Stack,
  user_id: string,
  transaction_id_a: string,
  transaction_id_b: string,
  row: Row = {},
): Promise<string> =>
  (
    await stack.db.insert<{ pair_id: string }>("transaction_pairs", {
      pair_id: crypto.randomUUID(),
      user_id,
      transaction_id_a,
      transaction_id_b,
      status: "suggested",
      ...row,
    })
  ).pair_id;

/** A recurring owned by `user_id`; its id is returned. `transaction_ids` and `splits` may be given as arrays. */
export const seedRecurring = async (stack: Stack, user_id: string, row: Row = {}): Promise<string> => {
  const { splits, ...rest } = row;
  const recurring_id = (
    await stack.db.insert<{ recurring_id: string }>("recurrings", {
      recurring_id: crypto.randomUUID(),
      user_id,
      merchant_key: "seeded merchant",
      merchant_name: "Seeded Merchant",
      cadence: "monthly",
      is_income: false,
      status: "suggested",
      transaction_ids: [],
      ...rest,
    })
  ).recurring_id;
  if (splits !== undefined) {
    await stack.db.query("UPDATE recurrings SET splits = $2::jsonb WHERE recurring_id = $1", [recurring_id, JSON.stringify(splits)]);
  }
  return recurring_id;
};

/** Puts the users in one sharing group, as accepting invitations does. */
export const shareData = async (stack: Stack, ...user_ids: string[]): Promise<string> => {
  const group_id = crypto.randomUUID();
  for (const user_id of user_ids) await stack.db.insert("sharing_members", { user_id, group_id });
  return group_id;
};

const PRIMARY_KEYS: Record<string, string> = {
  transactions: "transaction_id",
  transaction_pairs: "pair_id",
  recurrings: "recurring_id",
  split_transactions: "split_transaction_id",
};

/**
 * Every row of `table` matching `where`, as plain JSON (a DATE as
 * `YYYY-MM-DD`, a NUMERIC as a number, a TIMESTAMPTZ as the database's text),
 * ordered by `orderBy` (the primary key by default).
 */
export const stored = async (stack: Stack, table: string, where: Row = {}, orderBy?: string): Promise<StoredRow[]> => {
  const keys = Object.keys(where);
  const conditions = keys.map((key, i) => `t.${key} = $${i + 1}`);
  const rows = await stack.db.query<{ row: StoredRow }>(
    `SELECT to_jsonb(t) AS row FROM ${table} t${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY ${orderBy ?? `t.${PRIMARY_KEYS[table]}`}`,
    keys.map((key) => where[key]),
  );
  return rows.map(({ row }) => row);
};

/** The row of `table` whose primary key is `id`. */
export const storedOne = async (stack: Stack, table: string, id: string): Promise<StoredRow | undefined> =>
  (await stored(stack, table, { [PRIMARY_KEYS[table]]: id }))[0];

/** The columns of a row a test cares about. */
export const pick = (row: StoredRow | undefined, columns: string[]): Record<string, unknown> | undefined =>
  row && Object.fromEntries(columns.map((column) => [column, row[column]]));

/** The label columns of transactions, by id, in id order. */
export const storedLabels = async (stack: Stack, transaction_ids: string[]): Promise<Record<string, unknown>[]> =>
  stack.db.query(
    `SELECT transaction_id, label_budget_id::text, label_category_id::text, label_category_confidence
     FROM transactions WHERE transaction_id = ANY($1::text[]) ORDER BY transaction_id`,
    [transaction_ids],
  );

/** The live split transactions of transactions, in transaction then amount order. */
export const storedSplits = async (stack: Stack, transaction_ids: string[]): Promise<Record<string, unknown>[]> =>
  stack.db.query(
    `SELECT transaction_id, account_id, amount::float8 AS amount, to_char(date, 'YYYY-MM-DD') AS date,
            label_budget_id::text, label_category_id::text, label_category_confidence
     FROM split_transactions
     WHERE transaction_id = ANY($1::text[]) AND (is_deleted IS NULL OR is_deleted = FALSE)
     ORDER BY transaction_id, amount, label_budget_id NULLS FIRST`,
    [transaction_ids],
  );

/** The counts a job logged with `message`, from its latest log line. */
export const loggedCounts = (stack: Stack, message: string): Record<string, unknown> => {
  const line = [...stack.logs].reverse().find((l) => l.includes(message));
  if (!line) throw new Error(`no "${message}" line in the log`);
  return JSON.parse(line.slice(line.indexOf("{")));
};

/** Every context a job logged with `message` since the log held `from` lines. */
export const loggedContexts = (stack: Stack, message: string, from = 0): Record<string, unknown>[] =>
  stack.logs
    .slice(from)
    .filter((line) => line.includes(message) && line.includes("{"))
    .map((line) => {
      const text = line.slice(line.indexOf("{"));
      const end = text.lastIndexOf("}");
      return JSON.parse(text.slice(0, end + 1));
    });

/**
 * While `run` runs, a statement on `table` that would write a row matching
 * `condition` (SQL over `NEW` or `OLD`) fails with `message`.
 */
export const withWritesFailing = async <T>(
  stack: Stack,
  table: string,
  when: "INSERT" | "UPDATE",
  condition: string,
  run: () => Promise<T>,
  message = "conformance: refused",
): Promise<T> => {
  await stack.db.query(
    `CREATE OR REPLACE FUNCTION conformance_refuse_write() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF ${condition} THEN RAISE EXCEPTION '${message.replace(/'/g, "''")}'; END IF;
       RETURN NEW;
     END $$`,
  );
  await stack.db.query(
    `CREATE TRIGGER conformance_refuse_write BEFORE ${when} ON ${table} FOR EACH ROW EXECUTE FUNCTION conformance_refuse_write()`,
  );
  try {
    return await run();
  } finally {
    await stack.db.query(`DROP TRIGGER conformance_refuse_write ON ${table}`);
  }
};
