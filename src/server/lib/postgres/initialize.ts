/**
 * Database initialization using model schemas.
 */

import { pool } from "./client";
import { searchUser, indexUser } from "./repositories";
import { buildCreateTable, buildCreateIndex } from "./database";
import {
  Table,
  userTable,
  sessionTable,
  institutionTable,
  securityTable,
  itemTable,
  accountTable,
  holdingTable,
  transactionTable,
  investmentTransactionTable,
  splitTransactionTable,
  budgetTable,
  sectionTable,
  categoryTable,
  snapshotTable,
  chartTable,
} from "./models";

export const version = "6";
export const index = "budget" + (version ? `-${version}` : "");

const tables: Table[] = [
  userTable,
  sessionTable,
  institutionTable,
  securityTable,
  itemTable,
  accountTable,
  holdingTable,
  transactionTable,
  investmentTransactionTable,
  splitTransactionTable,
  budgetTable,
  sectionTable,
  categoryTable,
  snapshotTable,
  chartTable,
];

export const initializeIndex = async (): Promise<void> => {
  console.info("Initialization started.");

  try {
    const client = await pool.connect();
    client.release();
    console.info("PostgreSQL connection established.");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.info(`PostgreSQL connection failed: ${message}`);
    console.info("Restarting initialization in 10 seconds.");
    return new Promise((res) => {
      setTimeout(() => res(initializeIndex()), 10000);
    });
  }

  try {
    for (const table of tables) {
      const createTableSql = buildCreateTable(
        table.name,
        table.schema,
        table.constraints
      );
      await pool.query(createTableSql);

      for (const idx of table.indexes) {
        const createIndexSql = buildCreateIndex(idx.table, idx.column);
        await pool.query(createIndexSql);
      }
    }

    console.info("Database tables created/verified successfully.");
  } catch (error: unknown) {
    console.error("Failed to create tables:", error);
    throw new Error("Failed to setup PostgreSQL tables.");
  }

  const { ADMIN_PASSWORD, DEMO_PASSWORD } = process.env;

  const existingAdminUser = await searchUser({ username: "admin" });

  const indexingAdminUserResult = await indexUser({
    user_id: existingAdminUser?.user_id,
    username: "admin",
    password: ADMIN_PASSWORD || "budget",
  });

  const createdAdminUserId = indexingAdminUserResult?._id;
  if (!createdAdminUserId) throw new Error("Failed to create admin user");

  const existingDemoUser = await searchUser({ username: "demo" });

  await indexUser({
    user_id: existingDemoUser?.user_id,
    username: "demo",
    password: DEMO_PASSWORD || "budget",
  });

  console.info("Successfully initialized PostgreSQL database and setup default users.");
};
