import { SQL } from "./sql-driver";
import { logger } from "../logger";

const {
  POSTGRES_HOST: host = "localhost",
  POSTGRES_PORT: port = "5432",
  POSTGRES_USER: user = "postgres",
  POSTGRES_PASSWORD: password,
  POSTGRES_DATABASE: database = "budget",
} = process.env;

/**
 * What `pool.query` / `client.query` resolve to: the rows plus the affected
 * row count. This is the shape the old pg `QueryResult` had, and every
 * caller in the repo already consumes it (`result.rows`,
 * `result.rowCount`), so the driver swap keeps it instead of leaking
 * Bun.sql's array-with-metadata result shape into repositories.
 */
export interface SqlQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number | null;
}

/** Anything that can run a parameterized query: the pool or a reserved client. */
export interface SqlExecutor {
  // Untyped callers get Record rows, the way pg's `any`-rowed QueryResult
  // let them read fields straight off a row (with casts where a field
  // feeds a typed parameter). Typed callers pass the row shape explicitly.
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<SqlQueryResult<T>>;
}

/** A single connection reserved from the pool (a transaction client). */
export interface SqlClient extends SqlExecutor {
  release(): void;
}

/** The pool: queries plus checkout and shutdown. */
export interface SqlPool extends SqlExecutor {
  connect(): Promise<SqlClient>;
  end(): Promise<void>;
}

// PostgreSQL type OIDs for the columns Bun.sql does NOT decode the way the
// repo's callers consume them. Bun.sql returns most types already decoded
// (numbers, booleans, strings, Dates, arrays, Buffers); these are the
// exceptions, verified against Bun 1.4.4 behavior on a live server:
//
// - NUMERIC (1700) / INT8 (20): Bun.sql returns strings; the repo consumes
//   floats (pg's custom parsers did `parseFloat`, including the float
//   rounding of values past 2^53 — reproduced, not "fixed" to BigInt).
// - DATE (1082): Bun.sql returns a Date at UTC midnight; the repo consumes
//   the raw "YYYY-MM-DD" string (pg returned DATE text untouched).
// - TIMESTAMPTZ (1184): Bun.sql returns a Date (the instant, with the
//   original offset lost); the repo consumes an ISO string (pg's custom
//   parser produced one with a colon offset). `toISOString()` keeps the
//   same instant in canonical form — `Z`, milliseconds included — which is
//   a text change, not a value change: every consumer parses it with
//   `new Date(...)` or compares it server-side in SQL, never by string
//   equality.
// - JSON (114) / JSONB (3802): Bun.sql on 1.4.4 returns values already
//   parsed (pg parsed them too), so the converter trusts that parse. It
//   must NOT re-parse strings: a top-level JSON string would be corrupted
//   ('"42"' -> 42) or throw ('"abc"'), failing the whole query.
const NUMERIC_OID = 1700;
const INT8_OID = 20;
const DATE_OID = 1082;
const TIMESTAMPTZ_OID = 1184;
const JSON_OID = 114;
const JSONB_OID = 3802;

interface BunSqlColumn {
  name: string;
  type: number;
}

type BunSqlResult = Array<Record<string, unknown>> & {
  count: number;
  columns: BunSqlColumn[];
};

function convertValue(value: unknown, oid: number): unknown {
  if (value === null || value === undefined) return value;
  switch (oid) {
    case NUMERIC_OID:
    case INT8_OID:
      return typeof value === "string" ? parseFloat(value) : value;
    case DATE_OID:
      return value instanceof Date ? value.toISOString().slice(0, 10) : value;
    case TIMESTAMPTZ_OID:
      return value instanceof Date ? value.toISOString() : value;
    case JSON_OID:
    case JSONB_OID:
      // Bun.sql on 1.4.4 already parsed this (see the header note); a
      // string here IS the value, not text waiting to be parsed.
      return value;
    default:
      return value;
  }
}

function convertResult<T>(result: BunSqlResult): SqlQueryResult<T> {
  // Bun.sql before 1.4.4 returns no `columns` at all, which used to make
  // conversion silently do nothing (NUMERIC stayed strings, JSON stayed
  // text, DATE stayed Dates). Fail loudly instead of serving wrong types.
  if (result.columns == null) {
    throw new Error(
      "Bun.sql returned no result columns; this build requires Bun 1.4.4 or newer",
    );
  }
  const columns = result.columns;
  const rows = (result as Array<Record<string, unknown>>).map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row as T;
    const converted: Record<string, unknown> = { ...row };
    for (const column of columns) {
      if (column.name in converted) {
        converted[column.name] = convertValue(converted[column.name], column.type);
      }
    }
    return converted as T;
  });
  return { rows, rowCount: result.count ?? null };
}

// Bun.sql reports a closed connection through `onclose`, which fires for
// routine closes too — an idle eviction and a clean `close()` are not
// connection loss. Only anything else (a killed backend, a refused
// reconnect) is worth the "Database connection lost" log the old pg
// `logDroppedConnections` handler produced. There is no pg-style
// attach-after-construction hook on Bun.sql, so the handler is wired here,
// at construction, instead of as a separate call in `start.ts`.
const IDLE_TIMEOUT_CODE = "ERR_POSTGRES_IDLE_TIMEOUT";
const CLEAN_CLOSE_CODE = "ERR_POSTGRES_CONNECTION_CLOSED";

export function isConnectionLoss(error: Error | null): boolean {
  if (!error) return false;
  const code = (error as { code?: unknown }).code;
  return code !== IDLE_TIMEOUT_CODE && code !== CLEAN_CLOSE_CODE;
}

const sqlOptions = {
  hostname: host,
  port: parseInt(port, 10),
  username: user,
  password,
  database,
  // Pool mapping from the old pg config: max 20, idle 30s, connect-timeout 2s.
  // Bun.sql takes both timeouts in SECONDS (pg took milliseconds).
  // `max` stays 20 even though Bun.sql opens all `max` connections on first
  // use (pg grew on demand): with `prepare: false` below, an idle backend
  // holds no statement cache, so the eager pool costs idle connections,
  // not the memory growth prepared statements used to cause.
  max: 20,
  idleTimeout: 30,
  connectionTimeout: 2,
  // Bun.sql defaults to `prepare: true`, keeping a named prepared statement
  // for every distinct SQL text on every connection. The repo builds many
  // distinct texts in normal operation (multi-row upserts sized by batch,
  // `IN ($1..$n)` lists sized by input, INSERT/UPDATE column sets that vary
  // by payload), so each backend's cache grows without bound; connections
  // are only recycled after 30 s idle. node-postgres used unnamed
  // statements, which don't accumulate — `prepare: false` restores that
  // behavior (a string bound to a JSONB column is parsed by the server
  // again, as pg did).
  prepare: false,
  onclose: (error: Error | null) => {
    if (isConnectionLoss(error)) {
      logger.error("Database connection lost", {}, error);
    }
  },
};

// Lazy client: construction is deferred to first use. `SQL` here is a LIVE
// ESM binding to `./sql-driver`'s export — bun's
// `mock.module("./sql-driver", () => ({ SQL: FakeSQL }))` from a test file
// re-points it, so the first query during that file's tests constructs the
// test's FakeSQL.
//
// `resetPool()` clears the cached instance so the NEXT first-use rebuilds
// against whatever `SQL` resolves to at that moment. Tests call this from
// `afterAll(restoreLeaves)` (`scripts/test-helpers.ts`) so file B's run
// doesn't inherit file A's FakeSQL. Production never calls `resetPool()` —
// the cached real client stays for the process lifetime.
//
// The cache also drops itself whenever the `SQL` binding moves, because an
// explicit reset only covers the files that run in the order their authors
// imagined: a file that touches the pool while the real driver is installed
// caches a real client, and the next file's `mock.module` cannot displace
// it — its queries reach a real socket. Comparing the constructor is what
// makes a file's own mock authoritative regardless of what ran before it.
// Production never re-points `SQL`, so the comparison holds and the client
// is built once.
let _sql: SQL | null = null;
let _sqlCtor: typeof SQL | null = null;
const getSql = (): SQL => {
  if (!_sql || _sqlCtor !== SQL) {
    _sql = new SQL(sqlOptions);
    _sqlCtor = SQL;
  }
  return _sql;
};
export const resetPool = (): void => {
  _sql = null;
};

async function runQuery<T>(
  unsafe: (text: string, values?: unknown[]) => Promise<unknown>,
  text: string,
  values?: unknown[],
): Promise<SqlQueryResult<T>> {
  const result = (await unsafe(text, values)) as BunSqlResult;
  return convertResult<T>(result);
}

export const pool: SqlPool = {
  query: async (text, values) => runQuery((t, v) => getSql().unsafe(t, v), text, values),
  connect: async () => {
    const reserved = await getSql().reserve();
    return {
      query: async (text, values) =>
        runQuery((t, v) => reserved.unsafe(t, v), text, values),
      release: () => reserved.release(),
    };
  },
  end: async () => {
    await getSql().close();
  },
};

/**
 * Execute a function within a database transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK.
 *
 * Runs on a reserved connection with manual statements — not Bun.sql's
 * `sql.begin()` helper — because the repo's transaction discipline needs
 * exact statement control (the migration's lock-before-BEGIN ordering and
 * its double-ROLLBACK quirk live in the same pattern).
 *
 * @param fn - Function to execute with the transaction client
 * @returns The result of the function
 * @throws Re-throws any error after rolling back the transaction
 */
export async function withTransaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
