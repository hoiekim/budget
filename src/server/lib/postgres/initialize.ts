import { pool } from "./client";
import { searchUser, writeUser } from "./repositories";
import { buildCreateTable, buildCreateIndex, buildSelectDuplicateKeys } from "./database";
import { runMigrations } from "./migration";
import { logger } from "server";
import {
  Table,
  Schema,
  usersTable,
  sessionsTable,
  institutionsTable,
  securitiesTable,
  itemsTable,
  accountsTable,
  holdingsTable,
  transactionsTable,
  transactionPairsTable,
  recurringsTable,
  investmentTransactionsTable,
  splitTransactionsTable,
  budgetsTable,
  sectionsTable,
  categoriesTable,
  snapshotsTable,
  chartsTable,
  apiKeysTable,
  rejectedCategoriesTable,
  cpiSnapshotsTable,
  sharingMembersTable,
  sharingInvitationsTable,
  CREATE_SHARING_USER_IDS_FUNCTION,
} from "./models";

export const version = "6";
export const index = "budget" + (version ? `-${version}` : "");

const tables: Table<unknown, Schema>[] = [
  usersTable,
  sessionsTable,
  institutionsTable,
  securitiesTable,
  itemsTable,
  accountsTable,
  holdingsTable,
  transactionsTable,
  transactionPairsTable,
  recurringsTable,
  investmentTransactionsTable,
  splitTransactionsTable,
  budgetsTable,
  sectionsTable,
  categoriesTable,
  snapshotsTable,
  chartsTable,
  apiKeysTable,
  rejectedCategoriesTable,
  cpiSnapshotsTable,
  sharingMembersTable,
  sharingInvitationsTable,
];

/**
 * Stops the start when existing rows share a key a unique index is about to
 * forbid, naming every shared key and nothing else of those rows. Postgres
 * refuses such an index too, but names only the first key it meets.
 */
const refuseDuplicateKeys = async (
  tableName: string,
  key: string | string[],
  where?: string,
): Promise<void> => {
  const { rows } = await pool.query(buildSelectDuplicateKeys(tableName, key, where));
  if (rows.length === 0) return;
  const keyName = Array.isArray(key) ? `(${key.join(", ")})` : key;
  const duplicates = rows.map((row) => `- ${Object.values(row).join(", ")}`);
  const message =
    `These values of ${keyName} are shared by more than one ${tableName} row, and must be unique.` +
    ` Change the rows so no two match, then start again:\n${duplicates.join("\n")}`;
  logger.error(message);
  throw new Error(message);
};

export const initializePostgres = async (): Promise<void> => {
  logger.info("Initialization started");

  try {
    const client = await pool.connect();
    client.release();
    logger.info("PostgreSQL connection established");
  } catch (error: unknown) {
    logger.warn("PostgreSQL connection failed, retrying in 10 seconds", {}, error);
    return new Promise((res) => {
      setTimeout(() => res(initializePostgres()), 10000);
    });
  }

  try {
    // pg_trgm enables similarity()-based fuzzy matching on merchant_name
    // (used by auto-categorization to group merchant_name variants).
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");

    for (const table of tables) {
      const createTableSql = buildCreateTable(table.name, table.schema, table.constraints);
      await pool.query(createTableSql);
    }
    logger.info("Database tables created/verified successfully");

    await pool.query(CREATE_SHARING_USER_IDS_FUNCTION);

    // Run automatic schema migrations to add any missing columns
    await runMigrations(tables.map((t) => ({ name: t.name, schema: t.schema })));

    // After the migrations, so an index can cover a column they just added.
    for (const table of tables) {
      for (const idx of table.indexes) {
        const key =
          "expression" in idx ? idx.expression : "columns" in idx ? idx.columns : idx.column;
        if (idx.unique) await refuseDuplicateKeys(table.name, key, idx.where);
        const name = "name" in idx ? idx.name : undefined;
        const createIndexSql = buildCreateIndex(table.name, key, name, idx);
        await pool.query(createIndexSql);
      }
    }
  } catch (error: unknown) {
    logger.error("Failed to create tables", {}, error);
    throw new Error("Failed to setup PostgreSQL tables.");
  }

  const { ADMIN_PASSWORD, DEMO_PASSWORD } = process.env;

  const existingAdminUser = await searchUser({ username: "admin" });
  const indexingAdminUserResult = await writeUser({
    user_id: existingAdminUser?.user_id,
    username: "admin",
    password: ADMIN_PASSWORD || "budget",
  });
  const createdAdminUserId = indexingAdminUserResult?._id;
  if (!createdAdminUserId) throw new Error("Failed to create admin user");

  const existingDemoUser = await searchUser({ username: "demo" });
  await writeUser({
    user_id: existingDemoUser?.user_id,
    username: "demo",
    password: DEMO_PASSWORD || "budget",
  });

  logger.info("Successfully initialized PostgreSQL database and setup default users");
};
