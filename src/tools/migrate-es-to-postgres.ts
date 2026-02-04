/**
 * Migration Tool: Elasticsearch to PostgreSQL
 * 
 * This script migrates data from an Elasticsearch JSON dump to PostgreSQL.
 * 
 * Usage:
 *   npx ts-node src/tools/migrate-es-to-postgres.ts
 * 
 * Environment Variables:
 *   ES_JSON_FILE - Path to JSON file with ES data (default: es_data.json)
 *   POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DATABASE
 */

import { Pool } from "pg";
import * as fs from "fs";
import * as path from "path";

interface ESHit {
  _id: string;
  _source: Record<string, any>;
}

// JSON file with ES data
const ES_JSON_FILE = process.env.ES_JSON_FILE || path.join(__dirname, "../../es_data.json");

// PostgreSQL configuration
const pgPool = new Pool({
  host: process.env.POSTGRES_HOST || "localhost",
  port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
  user: process.env.POSTGRES_USER || "budget",
  password: process.env.POSTGRES_PASSWORD || "budget",
  database: process.env.POSTGRES_DATABASE || "budget",
});

// Statistics
const stats: Record<string, { migrated: number; errors: number }> = {};

function initStats(type: string) {
  if (!stats[type]) {
    stats[type] = { migrated: 0, errors: 0 };
  }
}

// Maps ES user_id to PostgreSQL UUID
const userIdMap = new Map<string, string>();

async function migrateUser(doc: Record<string, any>): Promise<void> {
  const user = doc.user;
  if (!user) return;

  const { user_id, username, password, email, expiry, token } = user;
  
  try {
    // Check if user already exists
    const existing = await pgPool.query(
      "SELECT user_id FROM users WHERE username = $1",
      [username]
    );

    let pgUserId: string;

    if (existing.rows.length > 0) {
      pgUserId = existing.rows[0].user_id;
    } else {
      const result = await pgPool.query(
        `INSERT INTO users (username, password, email, expiry, token, updated)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
         RETURNING user_id`,
        [username, password, email, expiry, token]
      );
      pgUserId = result.rows[0].user_id;
    }

    userIdMap.set(user_id, pgUserId);
    initStats("user");
    stats.user.migrated++;
  } catch (error: any) {
    console.error(`Failed to migrate user ${username}:`, error.message);
    initStats("user");
    stats.user.errors++;
  }
}

async function migrateSession(doc: Record<string, any>): Promise<void> {
  const session = doc.session;
  if (!session) return;

  try {
    await pgPool.query(
      `INSERT INTO sessions (session_id, data, created_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (session_id) DO UPDATE SET data = $2`,
      [doc._id, JSON.stringify(session)]
    );
    initStats("session");
    stats.session.migrated++;
  } catch (error: any) {
    console.error(`Failed to migrate session:`, error.message);
    initStats("session");
    stats.session.errors++;
  }
}

async function migrateInstitution(doc: Record<string, any>): Promise<void> {
  const institution = doc.institution;
  if (!institution) return;

  try {
    await pgPool.query(
      `INSERT INTO institutions (institution_id, data, updated)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (institution_id) DO UPDATE SET data = $2`,
      [institution.institution_id, JSON.stringify(institution)]
    );
    initStats("institution");
    stats.institution.migrated++;
  } catch (error: any) {
    console.error(`Failed to migrate institution:`, error.message);
    initStats("institution");
    stats.institution.errors++;
  }
}

async function migrateItem(doc: Record<string, any>): Promise<void> {
  const item = doc.item;
  if (!item) return;

  const pgUserId = userIdMap.get(item.user_id);
  if (!pgUserId) {
    console.warn(`User not found for item ${item.item_id}, skipping`);
    initStats("item");
    stats.item.errors++;
    return;
  }

  try {
    await pgPool.query(
      `INSERT INTO items (item_id, user_id, data, updated)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (item_id) DO UPDATE SET data = $3, user_id = $2`,
      [item.item_id, pgUserId, JSON.stringify(item)]
    );
    initStats("item");
    stats.item.migrated++;
  } catch (error: any) {
    console.error(`Failed to migrate item ${item.item_id}:`, error.message);
    initStats("item");
    stats.item.errors++;
  }
}

async function migrateAccount(doc: Record<string, any>): Promise<void> {
  const account = doc.account;
  if (!account) return;

  const pgUserId = userIdMap.get(account.user_id);
  if (!pgUserId) {
    console.warn(`User not found for account ${account.account_id}, skipping`);
    initStats("account");
    stats.account.errors++;
    return;
  }

  try {
    const balances = account.balances || {};
    const label = account.label || {};
    const graphOptions = account.graph_options || {};
    
    // Remove fields that are stored separately
    const data = { ...account };
    delete data.balances;
    delete data.label;
    delete data.graph_options;
    delete data.user_id;

    await pgPool.query(
      `INSERT INTO accounts (account_id, user_id, balances, label, graph_options, data, updated)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (account_id) DO UPDATE SET 
         balances = $3, label = $4, graph_options = $5, data = $6, user_id = $2`,
      [account.account_id, pgUserId, JSON.stringify(balances), JSON.stringify(label), 
       JSON.stringify(graphOptions), JSON.stringify(data)]
    );
    initStats("account");
    stats.account.migrated++;
  } catch (error: any) {
    console.error(`Failed to migrate account ${account.account_id}:`, error.message);
    initStats("account");
    stats.account.errors++;
  }
}

async function migrateHolding(doc: Record<string, any>): Promise<void> {
  const holding = doc.holding;
  if (!holding) return;

  const pgUserId = userIdMap.get(holding.user_id);
  if (!pgUserId) {
    console.warn(`User not found for holding, skipping`);
    initStats("holding");
    stats.holding.errors++;
    return;
  }

  try {
    const holdingId = doc._id || `${holding.account_id}-${holding.security_id}`;
    await pgPool.query(
      `INSERT INTO holdings (holding_id, user_id, data, updated)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (holding_id) DO UPDATE SET data = $3, user_id = $2`,
      [holdingId, pgUserId, JSON.stringify(holding)]
    );
    initStats("holding");
    stats.holding.migrated++;
  } catch (error: any) {
    console.error(`Failed to migrate holding:`, error.message);
    initStats("holding");
    stats.holding.errors++;
  }
}

async function migrateSecurity(doc: Record<string, any>): Promise<void> {
  const security = doc.security;
  if (!security) return;

  try {
    await pgPool.query(
      `INSERT INTO securities (security_id, data, updated)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (security_id) DO UPDATE SET data = $2`,
      [security.security_id, JSON.stringify(security)]
    );
    initStats("security");
    stats.security.migrated++;
  } catch (error: any) {
    console.error(`Failed to migrate security:`, error.message);
    initStats("security");
    stats.security.errors++;
  }
}

async function migrateTransaction(doc: Record<string, any>): Promise<void> {
  const transaction = doc.transaction;
  if (!transaction) return;

  const pgUserId = userIdMap.get(transaction.user_id);
  if (!pgUserId) {
    console.warn(`User not found for transaction ${transaction.transaction_id}, skipping`);
    initStats("transaction");
    stats.transaction.errors++;
    return;
  }

  try {
    const label = transaction.label || {};
    const location = transaction.location || {};
    const paymentMeta = transaction.payment_meta || {};
    
    // Map label IDs - need to map ES IDs to PostgreSQL UUIDs
    let labelBudgetId = null;
    let labelCategoryId = null;
    if (label.budget_id) {
      labelBudgetId = budgetIdMap.get(label.budget_id) || null;
    }
    if (label.category_id) {
      labelCategoryId = categoryIdMap.get(label.category_id) || null;
    }

    await pgPool.query(
      `INSERT INTO transactions (
        transaction_id, user_id, account_id, pending_transaction_id,
        category_id, category, account_owner, name, amount,
        iso_currency_code, unofficial_currency_code, date, pending,
        payment_channel, authorized_date, authorized_datetime, datetime,
        transaction_code, location_address, location_city, location_region,
        location_postal_code, location_country, location_store_number,
        location_lat, location_lon, payment_meta_reference_number,
        payment_meta_ppd_id, payment_meta_payee, payment_meta_by_order_of,
        payment_meta_payer, payment_meta_payment_method,
        payment_meta_payment_processor, payment_meta_reason,
        label_budget_id, label_category_id, label_memo, updated
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
        $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32,
        $33, $34, $35, $36, $37, CURRENT_TIMESTAMP
      )
      ON CONFLICT (transaction_id) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        pending_transaction_id = EXCLUDED.pending_transaction_id,
        category_id = EXCLUDED.category_id,
        category = EXCLUDED.category,
        account_owner = EXCLUDED.account_owner,
        name = EXCLUDED.name,
        amount = EXCLUDED.amount,
        iso_currency_code = EXCLUDED.iso_currency_code,
        unofficial_currency_code = EXCLUDED.unofficial_currency_code,
        date = EXCLUDED.date,
        pending = EXCLUDED.pending,
        payment_channel = EXCLUDED.payment_channel,
        authorized_date = EXCLUDED.authorized_date,
        authorized_datetime = EXCLUDED.authorized_datetime,
        datetime = EXCLUDED.datetime,
        transaction_code = EXCLUDED.transaction_code,
        location_address = EXCLUDED.location_address,
        location_city = EXCLUDED.location_city,
        location_region = EXCLUDED.location_region,
        location_postal_code = EXCLUDED.location_postal_code,
        location_country = EXCLUDED.location_country,
        location_store_number = EXCLUDED.location_store_number,
        location_lat = EXCLUDED.location_lat,
        location_lon = EXCLUDED.location_lon,
        payment_meta_reference_number = EXCLUDED.payment_meta_reference_number,
        payment_meta_ppd_id = EXCLUDED.payment_meta_ppd_id,
        payment_meta_payee = EXCLUDED.payment_meta_payee,
        payment_meta_by_order_of = EXCLUDED.payment_meta_by_order_of,
        payment_meta_payer = EXCLUDED.payment_meta_payer,
        payment_meta_payment_method = EXCLUDED.payment_meta_payment_method,
        payment_meta_payment_processor = EXCLUDED.payment_meta_payment_processor,
        payment_meta_reason = EXCLUDED.payment_meta_reason,
        label_budget_id = EXCLUDED.label_budget_id,
        label_category_id = EXCLUDED.label_category_id,
        label_memo = EXCLUDED.label_memo,
        user_id = EXCLUDED.user_id,
        updated = CURRENT_TIMESTAMP`,
      [
        transaction.transaction_id,
        pgUserId,
        transaction.account_id || null,
        transaction.pending_transaction_id || null,
        transaction.category_id || null,
        transaction.category || null,
        transaction.account_owner || null,
        transaction.name || null,
        transaction.amount || 0,
        transaction.iso_currency_code || null,
        transaction.unofficial_currency_code || null,
        transaction.date || null,
        transaction.pending || false,
        transaction.payment_channel || null,
        transaction.authorized_date || null,
        transaction.authorized_datetime || null,
        transaction.datetime || null,
        transaction.transaction_code || null,
        location.address || null,
        location.city || null,
        location.region || null,
        location.postal_code || null,
        location.country || null,
        location.store_number || null,
        location.lat || null,
        location.lon || null,
        paymentMeta.reference_number || null,
        paymentMeta.ppd_id || null,
        paymentMeta.payee || null,
        paymentMeta.by_order_of || null,
        paymentMeta.payer || null,
        paymentMeta.payment_method || null,
        paymentMeta.payment_processor || null,
        paymentMeta.reason || null,
        labelBudgetId,
        labelCategoryId,
        label.memo || null,
      ]
    );
    initStats("transaction");
    stats.transaction.migrated++;
  } catch (error: any) {
    console.error(`Failed to migrate transaction ${transaction.transaction_id}:`, error.message);
    initStats("transaction");
    stats.transaction.errors++;
  }
}

async function migrateInvestmentTransaction(doc: Record<string, any>): Promise<void> {
  const invTx = doc.investment_transaction;
  if (!invTx) return;

  const pgUserId = userIdMap.get(invTx.user_id);
  if (!pgUserId) {
    console.warn(`User not found for investment transaction, skipping`);
    initStats("investment_transaction");
    stats.investment_transaction.errors++;
    return;
  }

  try {
    await pgPool.query(
      `INSERT INTO investment_transactions (investment_transaction_id, user_id, data, updated)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (investment_transaction_id) DO UPDATE SET data = $3, user_id = $2`,
      [invTx.investment_transaction_id, pgUserId, JSON.stringify(invTx)]
    );
    initStats("investment_transaction");
    stats.investment_transaction.migrated++;
  } catch (error: any) {
    console.error(`Failed to migrate investment transaction:`, error.message);
    initStats("investment_transaction");
    stats.investment_transaction.errors++;
  }
}

async function migrateSplitTransaction(doc: Record<string, any>): Promise<void> {
  const split = doc.split_transaction;
  if (!split) return;

  const pgUserId = userIdMap.get(split.user_id);
  if (!pgUserId) {
    console.warn(`User not found for split transaction, skipping`);
    initStats("split_transaction");
    stats.split_transaction.errors++;
    return;
  }

  try {
    const label = split.label || {};
    await pgPool.query(
      `INSERT INTO split_transactions (split_transaction_id, user_id, transaction_id, account_id, amount, date, custom_name, label, updated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
       ON CONFLICT (split_transaction_id) DO UPDATE SET 
         transaction_id = $3, account_id = $4, amount = $5, date = $6, custom_name = $7, label = $8, user_id = $2`,
      [split.split_transaction_id || doc._id, pgUserId, split.transaction_id, split.account_id, 
       split.amount || 0, split.date, split.custom_name || "", JSON.stringify(label)]
    );
    initStats("split_transaction");
    stats.split_transaction.migrated++;
  } catch (error: any) {
    console.error(`Failed to migrate split transaction:`, error.message);
    initStats("split_transaction");
    stats.split_transaction.errors++;
  }
}

// Map to store budget/section/category UUIDs
const budgetIdMap = new Map<string, string>();
const sectionIdMap = new Map<string, string>();
const categoryIdMap = new Map<string, string>();

async function migrateBudget(doc: Record<string, any>): Promise<void> {
  const budget = doc.budget;
  if (!budget) return;

  const pgUserId = userIdMap.get(budget.user_id);
  if (!pgUserId) {
    console.warn(`User not found for budget, skipping`);
    initStats("budget");
    stats.budget.errors++;
    return;
  }

  try {
    const result = await pgPool.query(
      `INSERT INTO budgets (user_id, name, iso_currency_code, capacities, roll_over, roll_over_start_date, updated)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       RETURNING budget_id`,
      [pgUserId, budget.name || "Unnamed", budget.iso_currency_code || "USD", 
       JSON.stringify(budget.capacities || []), budget.roll_over || false, budget.roll_over_start_date]
    );
    budgetIdMap.set(budget.budget_id || doc._id, result.rows[0].budget_id);
    initStats("budget");
    stats.budget.migrated++;
  } catch (error: any) {
    console.error(`Failed to migrate budget:`, error.message);
    initStats("budget");
    stats.budget.errors++;
  }
}

async function migrateSection(doc: Record<string, any>): Promise<void> {
  const section = doc.section;
  if (!section) return;

  const pgUserId = userIdMap.get(section.user_id);
  const pgBudgetId = budgetIdMap.get(section.budget_id);
  
  if (!pgUserId || !pgBudgetId) {
    console.warn(`User or budget not found for section, skipping`);
    initStats("section");
    stats.section.errors++;
    return;
  }

  try {
    const result = await pgPool.query(
      `INSERT INTO sections (user_id, budget_id, name, capacities, roll_over, roll_over_start_date, updated)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       RETURNING section_id`,
      [pgUserId, pgBudgetId, section.name || "Unnamed", 
       JSON.stringify(section.capacities || []), section.roll_over || false, section.roll_over_start_date]
    );
    sectionIdMap.set(section.section_id || doc._id, result.rows[0].section_id);
    initStats("section");
    stats.section.migrated++;
  } catch (error: any) {
    console.error(`Failed to migrate section:`, error.message);
    initStats("section");
    stats.section.errors++;
  }
}

async function migrateCategory(doc: Record<string, any>): Promise<void> {
  const category = doc.category;
  if (!category) return;

  const pgUserId = userIdMap.get(category.user_id);
  const pgSectionId = sectionIdMap.get(category.section_id);
  
  if (!pgUserId || !pgSectionId) {
    console.warn(`User or section not found for category, skipping`);
    initStats("category");
    stats.category.errors++;
    return;
  }

  try {
    const result = await pgPool.query(
      `INSERT INTO categories (user_id, section_id, name, capacities, roll_over, roll_over_start_date, updated)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       RETURNING category_id`,
      [pgUserId, pgSectionId, category.name || "Unnamed", 
       JSON.stringify(category.capacities || []), category.roll_over || false, category.roll_over_start_date]
    );
    // Store the mapping from ES category_id to PostgreSQL category_id
    categoryIdMap.set(category.category_id || doc._id, result.rows[0].category_id);
    initStats("category");
    stats.category.migrated++;
  } catch (error: any) {
    console.error(`Failed to migrate category:`, error.message);
    initStats("category");
    stats.category.errors++;
  }
}

async function migrateSnapshot(doc: Record<string, any>): Promise<void> {
  const snapshot = doc.snapshot;
  if (!snapshot) return;

  // Determine snapshot type and user
  let snapshotType = "balance";
  let userId: string | undefined;
  
  if (doc.account) {
    snapshotType = "account_balance";
    userId = doc.account.user_id;
  } else if (doc.security) {
    snapshotType = "security";
  } else if (doc.holding) {
    snapshotType = "holding";
    userId = doc.holding.user_id;
  }

  const pgUserId = userId ? userIdMap.get(userId) : null;

  try {
    const data = { ...doc };
    delete data.type;
    delete data._id;

    await pgPool.query(
      `INSERT INTO snapshots (snapshot_id, user_id, snapshot_date, snapshot_type, data, updated)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (snapshot_id) DO UPDATE SET data = $5, snapshot_type = $4`,
      [snapshot.snapshot_id, pgUserId, snapshot.date, snapshotType, JSON.stringify(data)]
    );
    initStats("snapshot");
    stats.snapshot.migrated++;
  } catch (error: any) {
    console.error(`Failed to migrate snapshot:`, error.message);
    initStats("snapshot");
    stats.snapshot.errors++;
  }
}

async function migrateChart(doc: Record<string, any>): Promise<void> {
  const chart = doc.chart;
  if (!chart) return;

  const pgUserId = userIdMap.get(chart.user_id);
  if (!pgUserId) {
    console.warn(`User not found for chart, skipping`);
    initStats("chart");
    stats.chart.errors++;
    return;
  }

  try {
    await pgPool.query(
      `INSERT INTO charts (user_id, name, type, configuration, updated)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
      [pgUserId, chart.name || "Unnamed", chart.type, JSON.stringify(chart.configuration || {})]
    );
    initStats("chart");
    stats.chart.migrated++;
  } catch (error: any) {
    console.error(`Failed to migrate chart:`, error.message);
    initStats("chart");
    stats.chart.errors++;
  }
}

async function migrateDocument(doc: ESHit): Promise<void> {
  const source = doc._source;
  const type = source.type;

  switch (type) {
    case "user":
      await migrateUser(source);
      break;
    case "session":
      await migrateSession({ ...source, _id: doc._id });
      break;
    case "institution":
      await migrateInstitution(source);
      break;
    case "item":
      await migrateItem(source);
      break;
    case "account":
      await migrateAccount(source);
      break;
    case "holding":
      await migrateHolding({ ...source, _id: doc._id });
      break;
    case "security":
      await migrateSecurity(source);
      break;
    case "transaction":
      await migrateTransaction(source);
      break;
    case "investment_transaction":
      await migrateInvestmentTransaction(source);
      break;
    case "split_transaction":
      await migrateSplitTransaction({ ...source, _id: doc._id });
      break;
    case "budget":
      await migrateBudget({ ...source, _id: doc._id });
      break;
    case "section":
      await migrateSection({ ...source, _id: doc._id });
      break;
    case "category":
      await migrateCategory(source);
      break;
    case "snapshot":
      await migrateSnapshot({ ...source, _id: doc._id });
      break;
    case "chart":
      await migrateChart(source);
      break;
    default:
      console.warn(`Unknown document type: ${type}`);
  }
}

async function migrate(): Promise<void> {
  console.log("========================================");
  console.log("Elasticsearch to PostgreSQL Migration");
  console.log("========================================");
  console.log(`JSON File: ${ES_JSON_FILE}`);
  console.log(`PG: ${process.env.POSTGRES_HOST || "localhost"}:${process.env.POSTGRES_PORT || "5432"}/${process.env.POSTGRES_DATABASE || "budget"}`);
  console.log("========================================\n");

  // Load JSON data
  console.log("Loading JSON data...");
  if (!fs.existsSync(ES_JSON_FILE)) {
    console.error(`JSON file not found: ${ES_JSON_FILE}`);
    process.exit(1);
  }
  
  const jsonData = JSON.parse(fs.readFileSync(ES_JSON_FILE, "utf-8")) as ESHit[];
  console.log(`✓ Loaded ${jsonData.length} documents from JSON file`);

  // Test PostgreSQL connection
  try {
    const client = await pgPool.connect();
    client.release();
    console.log("✓ PostgreSQL connection OK");
  } catch (error: any) {
    console.error("✗ PostgreSQL connection failed:", error.message);
    process.exit(1);
  }

  const totalDocs = jsonData.length;
  console.log(`\nTotal documents to migrate: ${totalDocs}\n`);

  // Group documents by type
  const docsByType: Record<string, ESHit[]> = {};
  for (const doc of jsonData) {
    const type = doc._source.type || "unknown";
    if (!docsByType[type]) docsByType[type] = [];
    docsByType[type].push(doc);
  }

  console.log("Document types found:");
  for (const [type, docs] of Object.entries(docsByType)) {
    console.log(`  ${type}: ${docs.length}`);
  }
  console.log("");

  // Phase 1: Migrate users first (need IDs for foreign keys)
  console.log("Phase 1: Migrating users...");
  for (const doc of docsByType.user || []) {
    await migrateDocument(doc);
  }
  console.log(`  Users migrated: ${stats.user?.migrated || 0}`);

  // Phase 2: Migrate budgets (before sections and categories)
  console.log("Phase 2: Migrating budgets...");
  for (const doc of docsByType.budget || []) {
    await migrateDocument(doc);
  }
  console.log(`  Budgets migrated: ${stats.budget?.migrated || 0}`);

  // Phase 3: Migrate sections (before categories)
  console.log("Phase 3: Migrating sections...");
  for (const doc of docsByType.section || []) {
    await migrateDocument(doc);
  }
  console.log(`  Sections migrated: ${stats.section?.migrated || 0}`);

  // Phase 4: Migrate categories (before transactions, so we can map label.category_id)
  console.log("Phase 4: Migrating categories...");
  for (const doc of docsByType.category || []) {
    await migrateDocument(doc);
  }
  console.log(`  Categories migrated: ${stats.category?.migrated || 0}`);

  // Phase 5: Migrate remaining documents
  console.log("Phase 5: Migrating remaining documents...");
  const skipTypes = new Set(["user", "budget", "section", "category"]);
  let processed = (docsByType.user?.length || 0) + (docsByType.budget?.length || 0) + (docsByType.section?.length || 0) + (docsByType.category?.length || 0);

  for (const [type, docs] of Object.entries(docsByType)) {
    if (skipTypes.has(type)) continue;
    
    for (const doc of docs) {
      await migrateDocument(doc);
      processed++;
      
      if (processed % 1000 === 0) {
        console.log(`  Processed ${processed} / ${totalDocs} documents...`);
      }
    }
  }

  // Print summary
  console.log("\n========================================");
  console.log("Migration Complete!");
  console.log("========================================");
  console.log("\nResults by type:");
  for (const [type, { migrated, errors }] of Object.entries(stats)) {
    console.log(`  ${type}: ${migrated} migrated, ${errors} errors`);
  }
  console.log(`\nTotal processed: ${processed}`);
  console.log("========================================\n");

  await pgPool.end();
  process.exit(0);
}

migrate().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
