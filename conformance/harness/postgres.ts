/**
 * One empty database per started server. Tests read and seed it directly
 * through `Database.sql`, so they can assert on what a request stored and set
 * up rows no endpoint creates.
 */
import { SQL } from "bun";
import { POSTGRES, TARGET } from "./config";

const connect = (database: string, max: number): SQL =>
  new SQL({
    hostname: POSTGRES.host,
    port: POSTGRES.port,
    username: POSTGRES.user,
    password: POSTGRES.password,
    database,
    max,
    prepare: false,
  });

export type Row = Record<string, unknown>;

export class Database {
  private constructor(
    readonly name: string,
    /** A connection pool on the database, for tests. */
    readonly sql: SQL,
  ) {}

  static async create(label: string): Promise<Database> {
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
    const name = `conf_${TARGET}_${label.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 24)}_${suffix}`;
    const admin = connect("postgres", 1);
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.close();
    }
    return new Database(name, connect(name, 4));
  }

  /** Runs one statement; `values` bind `$1…`. Rows come back as the driver decodes them. */
  async query<T extends Row = Row>(text: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.sql.unsafe(text, values);
    return [...result] as T[];
  }

  /** The first row, or `undefined`. */
  async one<T extends Row = Row>(text: string, values: unknown[] = []): Promise<T | undefined> {
    return (await this.query<T>(text, values))[0];
  }

  /**
   * Inserts one row and returns it. An object or array value is written as
   * JSON to a json column and as an array to an array column, the way the
   * driver sends them.
   */
  async insert<T extends Row = Row>(table: string, row: Row): Promise<T> {
    const columns = Object.keys(row).filter((key) => row[key] !== undefined);
    const placeholders = columns.map((_, i) => `$${i + 1}`);
    const rows = await this.query<T>(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
      columns.map((column) => row[column]),
    );
    return rows[0];
  }

  /** Every row of `table`, optionally filtered by equality on `where`, ordered by `orderBy`. */
  async rows<T extends Row = Row>(table: string, where: Row = {}, orderBy?: string): Promise<T[]> {
    const keys = Object.keys(where);
    const conditions = keys.map((key, i) => (where[key] === null ? `${key} IS NULL` : `${key} = $${i + 1}`));
    const values = keys.map((key) => where[key]);
    // A null condition takes no placeholder, so renumber the ones that do.
    let index = 0;
    const numbered = conditions.map((condition) =>
      condition.includes("$") ? condition.replace(/\$\d+/, `$${++index}`) : condition,
    );
    return this.query<T>(
      `SELECT * FROM ${table}${numbered.length ? ` WHERE ${numbered.join(" AND ")}` : ""}${orderBy ? ` ORDER BY ${orderBy}` : ""}`,
      values.filter((value) => value !== null),
    );
  }

  async drop(): Promise<void> {
    await this.sql.close();
    const admin = connect("postgres", 1);
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${this.name}" WITH (FORCE)`);
    } finally {
      await admin.close();
    }
  }
}
