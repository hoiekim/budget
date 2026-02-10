/**
 * Database initialization using model schemas.
 * Creates all necessary tables and indexes if they don't exist.
 */

import { pool } from "./client";
import { searchUser, indexUser } from "./repositories";
import { buildCreateTable, buildCreateIndex } from "./database";
import {
  // Table names
  USERS,
  SESSIONS,
  ITEMS,
  INSTITUTIONS,
  ACCOUNTS,
  HOLDINGS,
  SECURITIES,
  TRANSACTIONS,
  INVESTMENT_TRANSACTIONS,
  SPLIT_TRANSACTIONS,
  BUDGETS,
  SECTIONS,
  CATEGORIES,
  SNAPSHOTS,
  CHARTS,
  // Schemas
  userSchema,
  userConstraints,
  sessionSchema,
  itemSchema,
  itemConstraints,
  itemIndexes,
  institutionSchema,
  accountSchema,
  accountConstraints,
  accountIndexes,
  holdingSchema,
  holdingConstraints,
  holdingIndexes,
  securitySchema,
  transactionSchema,
  transactionConstraints,
  transactionIndexes,
  investmentTransactionSchema,
  investmentTransactionConstraints,
  investmentTransactionIndexes,
  splitTransactionSchema,
  splitTransactionConstraints,
  splitTransactionIndexes,
  budgetSchema,
  budgetConstraints,
  budgetIndexes,
  sectionSchema,
  sectionConstraints,
  sectionIndexes,
  categorySchema,
  categoryConstraints,
  categoryIndexes,
  snapshotSchema,
  snapshotConstraints,
  snapshotIndexes,
  chartSchema,
  chartConstraints,
  chartIndexes,
} from "./models";

export const version = "6";
export const index = "budget" + (version ? `-${version}` : "");

/**
 * Table definitions for ordered creation.
 * Tables are created in order to satisfy foreign key constraints.
 */
const tableDefinitions = [
  // Users first (no foreign keys)
  {
    name: USERS,
    schema: userSchema,
    constraints: userConstraints,
    indexes: [],
  },
  // Sessions (references users)
  {
    name: SESSIONS,
    schema: sessionSchema,
    constraints: [],
    indexes: [],
  },
  // Institutions (no foreign keys)
  {
    name: INSTITUTIONS,
    schema: institutionSchema,
    constraints: [],
    indexes: [],
  },
  // Securities (no foreign keys)
  {
    name: SECURITIES,
    schema: securitySchema,
    constraints: [],
    indexes: [],
  },
  // Items (references users)
  {
    name: ITEMS,
    schema: itemSchema,
    constraints: itemConstraints,
    indexes: itemIndexes,
  },
  // Accounts (references users)
  {
    name: ACCOUNTS,
    schema: accountSchema,
    constraints: accountConstraints,
    indexes: accountIndexes,
  },
  // Holdings (references users)
  {
    name: HOLDINGS,
    schema: holdingSchema,
    constraints: holdingConstraints,
    indexes: holdingIndexes,
  },
  // Transactions (references users)
  {
    name: TRANSACTIONS,
    schema: transactionSchema,
    constraints: transactionConstraints,
    indexes: transactionIndexes,
  },
  // Investment transactions (references users)
  {
    name: INVESTMENT_TRANSACTIONS,
    schema: investmentTransactionSchema,
    constraints: investmentTransactionConstraints,
    indexes: investmentTransactionIndexes,
  },
  // Split transactions (references users)
  {
    name: SPLIT_TRANSACTIONS,
    schema: splitTransactionSchema,
    constraints: splitTransactionConstraints,
    indexes: splitTransactionIndexes,
  },
  // Budgets (references users)
  {
    name: BUDGETS,
    schema: budgetSchema,
    constraints: budgetConstraints,
    indexes: budgetIndexes,
  },
  // Sections (references users, budgets)
  {
    name: SECTIONS,
    schema: sectionSchema,
    constraints: sectionConstraints,
    indexes: sectionIndexes,
  },
  // Categories (references users, sections)
  {
    name: CATEGORIES,
    schema: categorySchema,
    constraints: categoryConstraints,
    indexes: categoryIndexes,
  },
  // Snapshots
  {
    name: SNAPSHOTS,
    schema: snapshotSchema,
    constraints: snapshotConstraints,
    indexes: snapshotIndexes,
  },
  // Charts (references users)
  {
    name: CHARTS,
    schema: chartSchema,
    constraints: chartConstraints,
    indexes: chartIndexes,
  },
];

/**
 * Creates all necessary tables if they don't exist.
 * Uses model schemas for type-safe table creation.
 * Then creates or updates admin user with configured password.
 */
export const initializeIndex = async (): Promise<void> => {
  console.info("Initialization started.");

  try {
    // Test connection
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
    // Create tables in order
    for (const table of tableDefinitions) {
      const createTableSql = buildCreateTable(
        table.name,
        table.schema as Record<string, string>,
        table.constraints
      );
      await pool.query(createTableSql);

      // Create indexes
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

  // Setup default users
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
