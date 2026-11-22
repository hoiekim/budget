/**
 * Accounts, securities, holdings, snapshots and sharing groups written
 * straight to the database, and the stored rows read back: for what no
 * endpoint creates, and for asserting what a request stored.
 */
import type { Row } from "../postgres";
import type { Stack } from "../stack";

/** A row as plain JSON: a TIMESTAMPTZ as the database's text, a NUMERIC as a number, JSONB as stored. */
export type StoredRow = Record<string, unknown>;

const PRIMARY_KEYS: Record<string, string> = {
  accounts: "account_id",
  securities: "security_id",
  holdings: "holding_id",
  snapshots: "snapshot_id",
};

/** Every row of `table` matching `where`, as plain JSON, in primary-key order. */
export const storedRows = async (stack: Stack, table: string, where: Row = {}): Promise<StoredRow[]> => {
  const keys = Object.keys(where);
  const conditions = keys.map((key, i) => (where[key] === null ? `t.${key} IS NULL` : `t.${key} = $${i + 1}`));
  let index = 0;
  const numbered = conditions.map((condition) => (condition.includes("$") ? condition.replace(/\$\d+/, `$${++index}`) : condition));
  const rows = await stack.db.query<{ row: StoredRow }>(
    `SELECT to_jsonb(t) AS row FROM ${table} t${numbered.length ? ` WHERE ${numbered.join(" AND ")}` : ""} ORDER BY t.${PRIMARY_KEYS[table]}`,
    keys.map((key) => where[key]).filter((value) => value !== null),
  );
  return rows.map(({ row }) => row);
};

/** The row of `table` whose primary key is `id`, as plain JSON; `undefined` when there is none. */
export const storedRow = async (stack: Stack, table: string, id: string): Promise<StoredRow | undefined> =>
  (await storedRows(stack, table, { [PRIMARY_KEYS[table]]: id }))[0];

/** Leaves out the columns every write stamps, so rows compare by what was written. */
export const withoutStamps = (row: StoredRow | undefined): StoredRow | undefined => {
  if (!row) return row;
  const { updated: _updated, ...rest } = row;
  return rest;
};

export const softDelete = async (stack: Stack, table: string, id: string): Promise<void> => {
  await stack.db.query(`UPDATE ${table} SET is_deleted = TRUE WHERE ${PRIMARY_KEYS[table]} = $1`, [id]);
};

/** An account of `user_id`, with the columns no default fills. Returns its id. */
export const seedAccount = async (stack: Stack, user_id: string, account_id: string, row: Row = {}): Promise<string> => {
  await stack.db.insert("accounts", {
    account_id,
    user_id,
    item_id: `item-${account_id}`,
    institution_id: `ins-${account_id}`,
    name: `Account ${account_id}`,
    type: "investment",
    ...row,
  });
  return account_id;
};

export const seedSecurity = async (stack: Stack, security_id: string, row: Row = {}): Promise<string> => {
  await stack.db.insert("securities", { security_id, ...row });
  return security_id;
};

export const seedHolding = async (
  stack: Stack,
  user_id: string,
  account_id: string,
  security_id: string,
  row: Row = {},
): Promise<string> => {
  const holding_id = (row.holding_id as string | undefined) ?? `${account_id}-${security_id}`;
  await stack.db.insert("holdings", { holding_id, user_id, account_id, security_id, ...row });
  return holding_id;
};

/** One snapshot row, of any type; `snapshot_date` and the amounts are written as given. */
export const seedSnapshot = async (stack: Stack, row: Row & { snapshot_id: string; snapshot_type: string; snapshot_date: string }) => {
  await stack.db.insert("snapshots", row);
  return row.snapshot_id;
};

/**
 * `count` account-balance snapshots of one account, one per day back from
 * `lastDay`, ids `<account_id>-<YYYYMMDD>`, in one statement.
 */
export const seedAccountSnapshots = async (
  stack: Stack,
  user_id: string,
  account_id: string,
  count: number,
  lastDay = "2026-01-31",
): Promise<void> => {
  await stack.db.query(
    `INSERT INTO snapshots (snapshot_id, user_id, snapshot_type, snapshot_date, account_id, balances_current, balances_iso_currency_code)
     SELECT $1 || '-' || to_char(day, 'YYYYMMDD'), $2::uuid, 'account_balance', (day::text || 'T00:00:00Z')::timestamptz, $1, 1000 + n, 'USD'
     FROM generate_series(0, $3::int - 1) n, LATERAL (SELECT $4::date - n AS day) d`,
    [account_id, user_id, count, lastDay],
  );
};

/** Puts the users in one sharing group, as accepting an invitation does. */
export const shareData = async (stack: Stack, ...user_ids: string[]): Promise<string> => {
  const group_id = crypto.randomUUID();
  for (const user_id of user_ids) await stack.db.insert("sharing_members", { user_id, group_id });
  return group_id;
};

/**
 * While `run` runs, a write of `event` (`UPDATE`, `INSERT`) to a row of
 * `table` that `when` matches (a condition on `NEW`) either fails with
 * `conformance: refused` (`"raise"`) or is silently skipped, touching no row
 * (`"skip"`): the two ways a write can come back other than as asked.
 */
export const withWritesBroken = async <T>(
  stack: Stack,
  table: string,
  { event, when = "TRUE", mode }: { event: "UPDATE" | "INSERT"; when?: string; mode: "raise" | "skip" },
  run: () => Promise<T>,
): Promise<T> => {
  const action = mode === "raise" ? "RAISE EXCEPTION 'conformance: refused'" : "RETURN NULL";
  await stack.db.query(
    `CREATE OR REPLACE FUNCTION conformance_break_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${when} THEN ${action}; END IF; RETURN NEW; END $$`,
  );
  await stack.db.query(`CREATE TRIGGER conformance_break_write BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION conformance_break_write()`);
  try {
    return await run();
  } finally {
    await stack.db.query(`DROP TRIGGER conformance_break_write ON ${table}`);
  }
};

/** Every snapshot row of a security's price, oldest first. */
export const storedSecuritySnapshots = (stack: Stack, security_id: string) =>
  stack.db.query<{ snapshot_id: string; snapshot_date: string; close_price: number | null }>(
    `SELECT snapshot_id, to_char(snapshot_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS snapshot_date, close_price::float8 AS close_price
     FROM snapshots WHERE snapshot_type = 'security' AND security_id = $1 ORDER BY snapshot_date, snapshot_id`,
    [security_id],
  );

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` of a date's local day, as `getDateString` gives it. */
export const localDay = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** `YYYYMMDD` of a date's local day, as `getSquashedDateString` gives it. */
export const squashedDay = (date: Date): string => localDay(date).replace(/-/g, "");

/** `new LocalDate(day)`: midnight of a `YYYY-MM-DD` day in the local zone. */
export const localMidnight = (day: string): Date => new Date(`${day}T00:00:00`);
