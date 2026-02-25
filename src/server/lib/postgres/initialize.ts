import { pool } from "./client";
import { searchUser, writeUser } from "./repositories";
import { buildCreateTable, buildCreateIndex } from "./database";
import { logger } from "../logger";
import {
  Table,
  usersTable,
  sessionsTable,
  institutionsTable,
  securitiesTable,
  itemsTable,
  accountsTable,
  holdingsTable,
  transactionsTable,
  investmentTransactionsTable,
  splitTransactionsTable,
  budgetsTable,
  sectionsTable,
  categoriesTable,
  snapshotsTable,
  chartsTable,
} from "./models";

export const version = "6";
export const index = "budget" + (version ? `-${version}` : "");

const tables: Table<unknown, any>[] = [
  usersTable,
  sessionsTable,
  institutionsTable,
  securitiesTable,
  itemsTable,
  accountsTable,
  holdingsTable,
  transactionsTable,
  investmentTransactionsTable,
  splitTransactionsTable,
  budgetsTable,
  sectionsTable,
  categoriesTable,
  snapshotsTable,
  chartsTable,
];

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
    for (const table of tables) {
      const createTableSql = buildCreateTable(table.name, table.schema, table.constraints);
      await pool.query(createTableSql);

      for (const idx of table.indexes) {
        const createIndexSql = buildCreateIndex(table.name, idx.column);
        await pool.query(createIndexSql);
      }
    }
    logger.info("Database tables created/verified successfully");
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
