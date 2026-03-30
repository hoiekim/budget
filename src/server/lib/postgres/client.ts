import { Pool, PoolClient, PoolConfig, types } from "pg";
import { logger } from "../logger";

const {
  POSTGRES_HOST: host = "localhost",
  POSTGRES_PORT: port = "5432",
  POSTGRES_USER: user = "postgres",
  POSTGRES_PASSWORD: password,
  POSTGRES_DATABASE: database = "budget",
} = process.env;

const timestampToIso = (s: string) => {
  return s.replace(
    /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2})(:\d{2})?$/,
    (_, d, t, m) => `${d}T${t}${m || ":00"}`,
  );
};

const config: PoolConfig = {
  host,
  port: parseInt(port, 10),
  user,
  password,
  database,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  types: {
    getTypeParser(id, format) {
      if (id === types.builtins.NUMERIC) return parseFloat;
      if (id === types.builtins.INT8) return parseFloat;
      if (id === types.builtins.DATE) return (s: string) => s;
      if (id === types.builtins.TIMESTAMPTZ) return timestampToIso;
      return types.getTypeParser(id, format);
    },
  },
};

export const pool = new Pool(config);

// Process-level error handlers (SIGTERM/SIGINT are handled in start.ts for ordered shutdown)
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {}, reason);
});

process.on("uncaughtException", async (error) => {
  logger.error("Uncaught exception", {}, error);
  try {
    await pool.end();
  } catch {
    // ignore pool shutdown errors during crash
  }
  process.exit(1);
});


/**
 * Execute a function within a database transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK.
 *
 * @param fn - Function to execute with the transaction client
 * @returns The result of the function
 * @throws Re-throws any error after rolling back the transaction
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
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
