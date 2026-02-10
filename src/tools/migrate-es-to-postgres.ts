/**
 * Migration Tool: Elasticsearch to PostgreSQL
 *
 * This script migrates data from an Elasticsearch JSON dump to PostgreSQL.
 * Matches the flattened PostgreSQL schema used by the budget app.
 *
 * Usage:
 *   npx ts-node src/tools/migrate-es-to-postgres.ts
 *
 * Environment Variables:
 *   ES_JSON_FILE - Path to JSON file with ES data (default: es_data.json)
 *   POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DATABASE
 */

import { importConfig } from "../server/config";
importConfig();

import { Pool } from "pg";
import * as fs from "fs";
import * as path from "path";

type ESHit = Record<string, any>;

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

// ID Maps: ES ID -> PostgreSQL UUID
const userIdMap = new Map<string, string>();
const budgetIdMap = new Map<string, string>();
const sectionIdMap = new Map<string, string>();
const categoryIdMap = new Map<string, string>();

/**
 * Get the PostgreSQL user_id from an ES document source.
 * Tries source.user.user_id first, then falls back to entity.user_id.
 */
function getPgUserId(source: Record<string, any>, entity: Record<string, any>): string | undefined {
  const esUserId = source.user?.user_id || entity.user_id;
  return esUserId ? userIdMap.get(esUserId) : undefined;
}

async function migrate(): Promise<void> {
  console.log("=".repeat(50));
  console.log("ES → PostgreSQL Migration");
  console.log("=".repeat(50));

  // Load data
  console.log("\nLoading es_data.json...");
  if (!fs.existsSync(ES_JSON_FILE)) {
    console.error(`JSON file not found: ${ES_JSON_FILE}`);
    process.exit(1);
  }
  const jsonData = JSON.parse(fs.readFileSync(ES_JSON_FILE, "utf-8")) as ESHit[];
  console.log(`  Loaded ${jsonData.length} documents`);

  // Test PostgreSQL connection
  try {
    const client = await pgPool.connect();
    client.release();
    console.log("  PostgreSQL connection OK");
  } catch (error: any) {
    console.error("  PostgreSQL connection failed:", error.message);
    process.exit(1);
  }

  // =========================================
  // Phase 1: Clean existing data (except admin/demo users)
  // =========================================
  console.log("\n--- Phase 1: Clean existing data ---");
  const tablesToClean = [
    "charts",
    "snapshots",
    "holdings",
    "securities",
    "split_transactions",
    "investment_transactions",
    "transactions",
    "categories",
    "sections",
    "budgets",
    "accounts",
    "institutions",
    "items",
  ];
  for (const table of tablesToClean) {
    try {
      const result = await pgPool.query(`DELETE FROM ${table}`);
      console.log(`  Cleared ${table}: ${result.rowCount} rows`);
    } catch (error: any) {
      console.error(`  Error clearing ${table}:`, error.message);
    }
  }
  // Delete non-admin/demo users
  try {
    const result = await pgPool.query(`DELETE FROM users WHERE username NOT IN ('admin', 'demo')`);
    console.log(`  Cleared users (except admin/demo): ${result.rowCount} rows`);
  } catch (error: any) {
    console.error(`  Error clearing users:`, error.message);
  }

  // Group by type
  const byType: Record<string, ESHit[]> = {};
  for (const doc of jsonData) {
    const t = doc.type || "unknown";
    if (!byType[t]) byType[t] = [];
    byType[t].push(doc);
  }

  for (const [t, docs] of Object.entries(byType).sort()) {
    console.log(`  ${t}: ${docs.length}`);
  }

  // =========================================
  // Phase 2: Migrate users
  // =========================================
  console.log("\n--- Phase 2: Migrate users ---");
  let userCount = 0;
  for (const doc of byType.user || []) {
    const src = doc;
    const u = src.user || {};
    const esUserId = u.user_id || doc._id;
    const username = u.username || "";
    const password = u.password || "";

    try {
      const existing = await pgPool.query("SELECT user_id FROM users WHERE username = $1", [
        username,
      ]);

      let pgUserId: string;
      if (existing.rows.length > 0) {
        pgUserId = existing.rows[0].user_id;
      } else {
        const result = await pgPool.query(
          "INSERT INTO users (username, password) VALUES ($1, $2) RETURNING user_id",
          [username, password],
        );
        pgUserId = result.rows[0].user_id;
      }

      userIdMap.set(esUserId, pgUserId);
      console.log(`  User: ${username} (${esUserId} -> ${pgUserId})`);
      userCount++;
    } catch (error: any) {
      console.error(`  Error migrating user ${username}:`, error.message);
    }
  }
  console.log(`  Migrated ${userCount} users`);

  // =========================================
  // Phase 3: Migrate items
  // =========================================
  console.log("\n--- Phase 3: Migrate items ---");
  let itemCount = 0;
  for (const doc of byType.item || []) {
    const src = doc;
    const updated = doc.updated || new Date().toISOString();
    const item = src.item || {};
    const pgUserId = getPgUserId(src, item);
    if (!pgUserId) continue;

    try {
      await pgPool.query(
        `INSERT INTO items (item_id, user_id, access_token, institution_id, available_products, cursor, status, provider, raw, updated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (item_id) DO UPDATE SET
           access_token = EXCLUDED.access_token, institution_id = EXCLUDED.institution_id,
           available_products = EXCLUDED.available_products, cursor = EXCLUDED.cursor,
           status = EXCLUDED.status, provider = EXCLUDED.provider, raw = EXCLUDED.raw,
           updated = EXCLUDED.updated`,
        [
          item.item_id,
          pgUserId,
          item.access_token || null,
          item.institution_id || null,
          item.available_products || null,
          item.cursor || null,
          item.status || null,
          item.provider || null,
          JSON.stringify(item),
          updated,
        ],
      );
      itemCount++;
    } catch (error: any) {
      console.error(`  Error migrating item ${item.item_id}:`, error.message);
    }
  }
  console.log(`  Migrated ${itemCount} items`);

  // =========================================
  // Phase 4: Migrate institutions
  // =========================================
  console.log("\n--- Phase 4: Migrate institutions ---");
  let instCount = 0;
  for (const doc of byType.institution || []) {
    const src = doc;
    const updated = doc.updated || new Date().toISOString();
    const inst = src.institution || {};

    try {
      await pgPool.query(
        `INSERT INTO institutions (institution_id, name, raw, updated)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (institution_id) DO UPDATE SET
           name = EXCLUDED.name, raw = EXCLUDED.raw, updated = EXCLUDED.updated`,
        [inst.institution_id, inst.name || null, JSON.stringify(inst), updated],
      );
      instCount++;
    } catch (error: any) {
      console.error(`  Error migrating institution:`, error.message);
    }
  }
  console.log(`  Migrated ${instCount} institutions`);

  // =========================================
  // Phase 5: Migrate accounts (with NULL label_budget_id initially)
  // =========================================
  console.log("\n--- Phase 5: Migrate accounts ---");
  let acctCount = 0;
  for (const doc of byType.account || []) {
    const src = doc;
    const updated = doc.updated || new Date().toISOString();
    const acct = src.account || {};
    const pgUserId = getPgUserId(src, acct);
    if (!pgUserId) continue;

    const graph = acct.graph_options || acct.graphOptions || {};

    try {
      await pgPool.query(
        `INSERT INTO accounts (
          account_id, user_id, item_id, institution_id, name, type, subtype,
          balances_available, balances_current, balances_limit, balances_iso_currency_code,
          custom_name, hide, label_budget_id,
          graph_options_use_snapshots, graph_options_use_transactions, raw, updated
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (account_id) DO UPDATE SET
           item_id = EXCLUDED.item_id, institution_id = EXCLUDED.institution_id,
           name = EXCLUDED.name, type = EXCLUDED.type, subtype = EXCLUDED.subtype,
           balances_available = EXCLUDED.balances_available, balances_current = EXCLUDED.balances_current,
           balances_limit = EXCLUDED.balances_limit, balances_iso_currency_code = EXCLUDED.balances_iso_currency_code,
           custom_name = EXCLUDED.custom_name, hide = EXCLUDED.hide, raw = EXCLUDED.raw,
           updated = EXCLUDED.updated`,
        [
          acct.account_id,
          pgUserId,
          acct.item_id || null,
          acct.institution_id || null,
          acct.name || null,
          acct.type || null,
          acct.subtype || null,
          acct.balances?.available ?? null,
          acct.balances?.current ?? null,
          acct.balances?.limit ?? null,
          acct.balances?.iso_currency_code ?? null,
          acct.custom_name || null,
          acct.hide ?? null,
          null, // label_budget_id set to NULL initially, updated in Phase 16
          graph.use_snapshots ?? graph.useSnapshots ?? true,
          graph.use_transactions ?? graph.useTransactions ?? true,
          JSON.stringify(acct),
          updated,
        ],
      );
      acctCount++;
    } catch (error: any) {
      console.error(`  Error migrating account ${acct.account_id}:`, error.message);
    }
  }
  console.log(`  Migrated ${acctCount} accounts`);

  // =========================================
  // Phase 6: Migrate budgets
  // =========================================
  console.log("\n--- Phase 6: Migrate budgets ---");
  let budgetCount = 0;
  for (const doc of byType.budget || []) {
    const src = doc;
    const updated = doc.updated || new Date().toISOString();
    const budget = src.budget || {};
    const pgUserId = getPgUserId(src, budget);
    if (!pgUserId) continue;

    const esBid = budget.budget_id || doc._id;
    try {
      const result = await pgPool.query(
        `INSERT INTO budgets (user_id, name, iso_currency_code, roll_over, roll_over_start_date, capacities, updated)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING budget_id`,
        [
          pgUserId,
          budget.name || null,
          budget.iso_currency_code || "USD",
          budget.roll_over ?? null,
          budget.roll_over_start_date || null,
          JSON.stringify(budget.capacities),
          updated,
        ],
      );
      const pgBudgetId = result.rows[0].budget_id;
      budgetIdMap.set(esBid, pgBudgetId);
      console.log(`  Budget: ${budget.name} (${esBid} -> ${pgBudgetId})`);
      budgetCount++;
    } catch (error: any) {
      console.error(`  Error migrating budget:`, error.message);
    }
  }
  console.log(`  Migrated ${budgetCount} budgets`);

  // =========================================
  // Phase 7: Migrate sections
  // =========================================
  console.log("\n--- Phase 7: Migrate sections ---");
  let sectionCount = 0;
  for (const doc of byType.section || []) {
    const src = doc;
    const updated = doc.updated || new Date().toISOString();
    const section = src.section || {};
    const pgUserId = getPgUserId(src, section);
    const pgBudgetId = section.budget_id ? budgetIdMap.get(section.budget_id) : undefined;
    if (!pgUserId || !pgBudgetId) continue;

    const esSid = section.section_id || doc._id;
    try {
      const result = await pgPool.query(
        `INSERT INTO sections (user_id, budget_id, name, roll_over, roll_over_start_date, capacities, updated)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING section_id`,
        [
          pgUserId,
          pgBudgetId,
          section.name || null,
          section.roll_over ?? null,
          section.roll_over_start_date || null,
          JSON.stringify(section.capacities),
          updated,
        ],
      );
      const pgSectionId = result.rows[0].section_id;
      sectionIdMap.set(esSid, pgSectionId);
      console.log(`  Section: ${section.name} (${esSid} -> ${pgSectionId})`);
      sectionCount++;
    } catch (error: any) {
      console.error(`  Error migrating section:`, error.message);
    }
  }
  console.log(`  Migrated ${sectionCount} sections`);

  // =========================================
  // Phase 8: Migrate categories
  // =========================================
  console.log("\n--- Phase 8: Migrate categories ---");
  let categoryCount = 0;
  for (const doc of byType.category || []) {
    const src = doc;
    const updated = doc.updated || new Date().toISOString();
    const cat = src.category || {};
    const pgUserId = getPgUserId(src, cat);
    const pgSectionId = cat.section_id ? sectionIdMap.get(cat.section_id) : undefined;
    if (!pgUserId || !pgSectionId) continue;

    const esCid = cat.category_id || doc._id;
    try {
      const result = await pgPool.query(
        `INSERT INTO categories (user_id, section_id, name, roll_over, roll_over_start_date, capacities, updated)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING category_id`,
        [
          pgUserId,
          pgSectionId,
          cat.name || null,
          cat.roll_over ?? null,
          cat.roll_over_start_date || null,
          JSON.stringify(cat.capacities),
          updated,
        ],
      );
      const pgCategoryId = result.rows[0].category_id;
      categoryIdMap.set(esCid, pgCategoryId);
      console.log(`  Category: ${cat.name} (${esCid} -> ${pgCategoryId})`);
      categoryCount++;
    } catch (error: any) {
      console.error(`  Error migrating category:`, error.message);
    }
  }
  console.log(`  Migrated ${categoryCount} categories`);

  // =========================================
  // Phase 9: Migrate transactions
  // =========================================
  console.log("\n--- Phase 9: Migrate transactions ---");
  let txCount = 0;
  let txErrors = 0;
  let txLabelsPreserved = 0;
  let txLabelsMissing = 0;
  for (const doc of byType.transaction || []) {
    const src = doc;
    const updated = doc.updated || new Date().toISOString();
    const tx = src.transaction || {};
    const pgUserId = getPgUserId(src, tx);
    if (!pgUserId) {
      txErrors++;
      continue;
    }

    const label = tx.label || {};

    const pgBudgetId = label.budget_id ? budgetIdMap.get(label.budget_id) || null : null;
    const pgCategoryId = label.category_id ? categoryIdMap.get(label.category_id) || null : null;

    // Track label mapping stats
    if (label.budget_id || label.category_id) {
      if (pgBudgetId || pgCategoryId) {
        txLabelsPreserved++;
      } else {
        txLabelsMissing++;
        if (txLabelsMissing <= 3) {
          console.log(
            `  ⚠ Label not mapped for tx ${tx.transaction_id}: ES budget=${label.budget_id}, category=${label.category_id}`,
          );
        }
      }
    }

    // Build the raw object with all data for JSONB storage
    const rawTx = { ...tx, label: { ...label, budget_id: pgBudgetId, category_id: pgCategoryId } };

    try {
      await pgPool.query(
        `INSERT INTO transactions (
          transaction_id, user_id, account_id, name, merchant_name, amount,
          iso_currency_code, date, pending, pending_transaction_id, payment_channel,
          location_country, location_region, location_city,
          label_budget_id, label_category_id, label_memo, raw, updated
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (transaction_id) DO NOTHING`,
        [
          tx.transaction_id,
          pgUserId,
          tx.account_id || null,
          tx.name || null,
          tx.merchant_name || null,
          tx.amount || 0,
          tx.iso_currency_code || null,
          tx.authorized_date || tx.date || null,
          tx.pending ?? false,
          tx.pending_transaction_id || null,
          tx.payment_channel || null,
          tx.location?.country || null,
          tx.location?.region || null,
          tx.location?.city || null,
          pgBudgetId,
          pgCategoryId,
          label.memo || null,
          JSON.stringify(rawTx),
          updated,
        ],
      );
      txCount++;
      if (txCount % 500 === 0) console.log(`  Progress: ${txCount}...`);
    } catch (error: any) {
      txErrors++;
      if (txErrors <= 5) {
        console.error(`  Error migrating transaction ${tx.transaction_id}:`, error.message);
      }
    }
  }
  console.log(`  Migrated ${txCount} transactions (${txErrors} errors)`);
  console.log(`  Labels: ${txLabelsPreserved} preserved, ${txLabelsMissing} missing mappings`);

  // =========================================
  // Phase 10: Migrate investment transactions
  // =========================================
  console.log("\n--- Phase 10: Migrate investment transactions ---");
  let invCount = 0;
  for (const doc of byType.investment_transaction || []) {
    const src = doc;
    const inv = src.investment_transaction || {};
    const updated =
      doc.updated || (inv.date ? new Date(inv.date + "Z").toISOString() : new Date().toISOString());
    const pgUserId = getPgUserId(src, inv);
    if (!pgUserId) continue;

    try {
      await pgPool.query(
        `INSERT INTO investment_transactions (
          investment_transaction_id, user_id, account_id, security_id,
          date, name, quantity, amount, price, iso_currency_code, type, subtype, raw, updated
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (investment_transaction_id) DO NOTHING`,
        [
          inv.investment_transaction_id,
          pgUserId,
          inv.account_id || null,
          inv.security_id || null,
          inv.date || null,
          inv.name || null,
          inv.quantity ?? null,
          inv.amount ?? null,
          inv.price ?? null,
          inv.iso_currency_code || null,
          inv.type || null,
          inv.subtype || null,
          JSON.stringify(inv),
          updated,
        ],
      );
      invCount++;
    } catch (error: any) {
      console.error(`  Error migrating investment transaction:`, error.message);
    }
  }
  console.log(`  Migrated ${invCount} investment transactions`);

  // =========================================
  // Phase 11: Migrate split transactions
  // =========================================
  console.log("\n--- Phase 11: Migrate split transactions ---");
  let splitCount = 0;
  for (const doc of byType.split_transaction || []) {
    const src = doc;
    const updated = doc.updated || new Date().toISOString();
    const split = src.split_transaction || {};
    const pgUserId = getPgUserId(src, split);
    if (!pgUserId) continue;

    const label = split.label || {};
    const pgBudgetId = label.budget_id ? budgetIdMap.get(label.budget_id) || null : null;
    const pgCategoryId = label.category_id ? categoryIdMap.get(label.category_id) || null : null;

    try {
      await pgPool.query(
        `INSERT INTO split_transactions (
          split_transaction_id, user_id, transaction_id, account_id,
          amount, date, custom_name, label_budget_id, label_category_id, label_memo, updated
        ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          pgUserId,
          split.transaction_id || null,
          split.account_id || null,
          split.amount ?? 0,
          split.date || null,
          split.custom_name || "",
          pgBudgetId,
          pgCategoryId,
          label.memo || null,
          updated,
        ],
      );
      splitCount++;
    } catch (error: any) {
      console.error(`  Error migrating split transaction:`, error.message);
    }
  }
  console.log(`  Migrated ${splitCount} split transactions`);

  // =========================================
  // Phase 12: Migrate securities
  // =========================================
  console.log("\n--- Phase 12: Migrate securities ---");
  let secCount = 0;
  for (const doc of byType.security || []) {
    const src = doc;
    const updated = doc.updated || new Date().toISOString();
    const sec = src.security || {};

    try {
      await pgPool.query(
        `INSERT INTO securities (
          security_id, name, ticker_symbol, type,
          close_price, close_price_as_of, iso_currency_code, isin, cusip, raw, updated
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (security_id) DO NOTHING`,
        [
          sec.security_id,
          sec.name || null,
          sec.ticker_symbol || null,
          sec.type || null,
          sec.close_price ?? null,
          sec.close_price_as_of || null,
          sec.iso_currency_code || null,
          sec.isin || null,
          sec.cusip || null,
          JSON.stringify(sec),
          updated,
        ],
      );
      secCount++;
    } catch (error: any) {
      console.error(`  Error migrating security:`, error.message);
    }
  }
  console.log(`  Migrated ${secCount} securities`);

  // =========================================
  // Phase 13: Migrate holdings
  // =========================================
  console.log("\n--- Phase 13: Migrate holdings ---");
  let holdCount = 0;
  for (const doc of byType.holding || []) {
    const src = doc;
    const updated = doc.updated || new Date().toISOString();
    const hold = src.holding || {};
    const esUserId = src.user?.user_id;
    const pgUserId = esUserId ? userIdMap.get(esUserId) : undefined;
    if (!pgUserId) continue;

    const holdingId = hold.holding_id || `${hold.account_id}_${hold.security_id}`;
    try {
      await pgPool.query(
        `INSERT INTO holdings (
          holding_id, user_id, account_id, security_id,
          institution_price, institution_price_as_of, institution_value, cost_basis, quantity,
          iso_currency_code, raw, updated
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (holding_id) DO NOTHING`,
        [
          holdingId,
          pgUserId,
          hold.account_id || null,
          hold.security_id || null,
          hold.institution_price ?? null,
          hold.institution_price_as_of || null,
          hold.institution_value ?? null,
          hold.cost_basis ?? null,
          hold.quantity ?? null,
          hold.iso_currency_code || null,
          JSON.stringify(hold),
          updated,
        ],
      );
      holdCount++;
    } catch (error: any) {
      console.error(`  Error migrating holding:`, error.message);
    }
  }
  console.log(`  Migrated ${holdCount} holdings`);

  // =========================================
  // Phase 14: Migrate snapshots
  // =========================================
  console.log("\n--- Phase 14: Migrate snapshots ---");
  let snapCount = 0;
  for (const doc of byType.snapshot || []) {
    const src = doc;
    const snap = src.snapshot || {};
    const updated = doc.updated || snap.date || new Date().toISOString();
    const esUserId = src.user?.user_id;
    const pgUserId = esUserId ? userIdMap.get(esUserId) : null;

    try {
      if (src.security) {
        // Security snapshot
        const sec = src.security;
        await pgPool.query(
          `INSERT INTO snapshots (snapshot_id, snapshot_date, snapshot_type, security_id, close_price, updated)
           VALUES ($1, $2, 'security', $3, $4, $5)
           ON CONFLICT (snapshot_id) DO NOTHING`,
          [snap.snapshot_id, snap.date, sec.security_id, sec.close_price ?? null, updated],
        );
      } else if (src.holding) {
        // Holding snapshot
        const hold = src.holding;
        await pgPool.query(
          `INSERT INTO snapshots (
            snapshot_id, user_id, snapshot_date, snapshot_type,
            holding_account_id, holding_security_id,
            institution_price, institution_value, cost_basis, quantity, updated
          ) VALUES ($1, $2, $3, 'holding', $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (snapshot_id) DO NOTHING`,
          [
            snap.snapshot_id,
            pgUserId,
            snap.date,
            hold.account_id || null,
            hold.security_id || null,
            hold.institution_price ?? null,
            hold.institution_value ?? null,
            hold.cost_basis ?? null,
            hold.quantity ?? null,
            updated,
          ],
        );
      } else if (src.account) {
        // Account balance snapshot
        const acct = src.account;
        const bal = acct.balances || {};

        // fixes an existing minor data quality issue
        const snapshot_id =
          snap.snapshot_id.indexOf("undefined") === 0
            ? acct.account_id + snap.snapshot_id.split("undefined")[1]
            : snap.snapshot_id;

        await pgPool.query(
          `INSERT INTO snapshots (
            snapshot_id, user_id, snapshot_date, snapshot_type,
            account_id, balances_available, balances_current, balances_limit,
            balances_iso_currency_code, updated
          ) VALUES ($1, $2, $3, 'account_balance', $4, $5, $6, $7, $8, $9)
           ON CONFLICT (snapshot_id) DO NOTHING`,
          [
            snapshot_id,
            pgUserId,
            snap.date,
            acct.account_id || null,
            bal.available ?? null,
            bal.current ?? null,
            bal.limit ?? null,
            bal.iso_currency_code || null,
            updated,
          ],
        );
      } else {
        continue;
      }
      snapCount++;
      if (snapCount % 500 === 0) console.log(`  Progress: ${snapCount}...`);
    } catch (error: any) {
      console.error(`  Error migrating snapshot:`, error.message);
    }
  }
  console.log(`  Migrated ${snapCount} snapshots`);

  // =========================================
  // Phase 15: Migrate charts
  // =========================================
  console.log("\n--- Phase 15: Migrate charts ---");
  let chartCount = 0;
  for (const doc of byType.chart || []) {
    const src = doc;
    const updated = doc.updated || new Date().toISOString();
    const chart = src.chart || {};
    const pgUserId = getPgUserId(src, chart);
    if (!pgUserId) continue;

    // Parse configuration if it's a JSON string
    let config = chart.configuration || {};
    if (typeof config === "string") {
      try {
        config = JSON.parse(config);
      } catch {
        config = {};
      }
    }
    // Map budget_ids from ES IDs to PG UUIDs
    if (config.budget_ids && Array.isArray(config.budget_ids)) {
      const originalIds = [...config.budget_ids];
      config.budget_ids = config.budget_ids
        .map((esId: string) => budgetIdMap.get(esId))
        .filter(Boolean);
      console.log(
        `  Chart "${chart.name}": mapped ${originalIds.length} budget_ids -> ${config.budget_ids.length} valid UUIDs`,
      );
    }
    // account_ids use original Plaid IDs, no mapping needed
    try {
      await pgPool.query(
        `INSERT INTO charts (user_id, name, type, configuration, updated)
         VALUES ($1, $2, $3, $4, $5)`,
        [pgUserId, chart.name || null, chart.type || null, JSON.stringify(config), updated],
      );
      chartCount++;
    } catch (error: any) {
      console.error(`  Error migrating chart:`, error.message);
    }
  }
  console.log(`  Migrated ${chartCount} charts`);

  // =========================================
  // Phase 16: Update account label_budget_id
  // =========================================
  console.log("\n--- Phase 16: Update account label_budget_id ---");
  let acctLabelCount = 0;
  for (const doc of byType.account || []) {
    const src = doc;
    const acct = src.account || {};
    const label = acct.label || {};
    const esBid = label.budget_id;
    if (!esBid) continue;

    const pgBid = budgetIdMap.get(esBid);
    if (!pgBid) continue;

    try {
      await pgPool.query("UPDATE accounts SET label_budget_id = $1 WHERE account_id = $2", [
        pgBid,
        acct.account_id,
      ]);
      acctLabelCount++;
    } catch (error: any) {
      console.error(`  Error updating account label:`, error.message);
    }
  }
  console.log(`  Updated ${acctLabelCount} account labels`);

  // =========================================
  // Summary & Verification
  // =========================================
  console.log("\n" + "=".repeat(50));
  console.log("Migration Complete!");
  console.log("=".repeat(50));

  const tables = [
    "users",
    "items",
    "accounts",
    "budgets",
    "sections",
    "categories",
    "transactions",
    "investment_transactions",
    "split_transactions",
    "securities",
    "holdings",
    "snapshots",
    "charts",
  ];
  for (const table of tables) {
    try {
      const result = await pgPool.query(`SELECT COUNT(*) FROM ${table}`);
      console.log(`  ${table}: ${result.rows[0].count}`);
    } catch {
      console.log(`  ${table}: ?`);
    }
  }

  // Verify transaction labels
  try {
    const result = await pgPool.query(
      `SELECT COUNT(*) as total,
              COUNT(label_category_id) as with_category,
              COUNT(label_budget_id) as with_budget
       FROM transactions`,
    );
    const row = result.rows[0];
    console.log(
      `\n  Transaction labels: total=${row.total}, with_category=${row.with_category}, with_budget=${row.with_budget}`,
    );
  } catch (error: any) {
    console.error(`  Error verifying transaction labels:`, error.message);
  }

  // =========================================
  // Referential Integrity Checks
  // =========================================
  console.log("\n--- Referential Integrity Checks ---");
  const integrityChecks = [
    {
      name: "transactions → budgets (label_budget_id)",
      query: `SELECT COUNT(*) as orphans FROM transactions t
               WHERE t.label_budget_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM budgets b WHERE b.budget_id = t.label_budget_id)`,
    },
    {
      name: "transactions → categories (label_category_id)",
      query: `SELECT COUNT(*) as orphans FROM transactions t
               WHERE t.label_category_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.category_id = t.label_category_id)`,
    },
    {
      name: "accounts → budgets (label_budget_id)",
      query: `SELECT COUNT(*) as orphans FROM accounts a
               WHERE a.label_budget_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM budgets b WHERE b.budget_id = a.label_budget_id)`,
    },
    {
      name: "sections → budgets (budget_id)",
      query: `SELECT COUNT(*) as orphans FROM sections s
               WHERE NOT EXISTS (SELECT 1 FROM budgets b WHERE b.budget_id = s.budget_id)`,
    },
    {
      name: "categories → sections (section_id)",
      query: `SELECT COUNT(*) as orphans FROM categories c
               WHERE NOT EXISTS (SELECT 1 FROM sections s WHERE s.section_id = c.section_id)`,
    },
    {
      name: "split_transactions → budgets (label_budget_id)",
      query: `SELECT COUNT(*) as orphans FROM split_transactions st
               WHERE st.label_budget_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM budgets b WHERE b.budget_id = st.label_budget_id)`,
    },
    {
      name: "split_transactions → categories (label_category_id)",
      query: `SELECT COUNT(*) as orphans FROM split_transactions st
               WHERE st.label_category_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.category_id = st.label_category_id)`,
    },
  ];

  // Check chart configuration budget_ids
  let chartOrphans = 0;
  try {
    const chartRows = await pgPool.query(`SELECT chart_id, configuration FROM charts`);
    const budgetResult = await pgPool.query(`SELECT budget_id FROM budgets`);
    const validBudgetIds = new Set(budgetResult.rows.map((r: any) => r.budget_id));
    for (const row of chartRows.rows) {
      try {
        const config =
          typeof row.configuration === "string" ? JSON.parse(row.configuration) : row.configuration;
        if (config?.budget_ids) {
          for (const bid of config.budget_ids) {
            if (!validBudgetIds.has(bid)) {
              chartOrphans++;
              console.log(`  ⚠ Chart ${row.chart_id} references invalid budget_id: ${bid}`);
            }
          }
        }
      } catch {
        /* skip parse errors */
      }
    }
  } catch (error: any) {
    console.error(`  Error checking chart budget_ids:`, error.message);
  }

  let allGood = true;
  for (const check of integrityChecks) {
    try {
      const result = await pgPool.query(check.query);
      const orphans = parseInt(result.rows[0].orphans);
      if (orphans > 0) {
        console.log(`  ⚠ ${check.name}: ${orphans} orphaned references`);
        allGood = false;
      } else {
        console.log(`  ✓ ${check.name}: OK`);
      }
    } catch (error: any) {
      console.error(`  ✗ ${check.name}: ${error.message}`);
      allGood = false;
    }
  }

  if (chartOrphans > 0) {
    console.log(
      `  ⚠ charts → budgets (configuration.budget_ids): ${chartOrphans} orphaned references`,
    );
    allGood = false;
  } else {
    console.log(`  ✓ charts → budgets (configuration.budget_ids): OK`);
  }

  if (allGood) {
    console.log("\n  ✅ All referential integrity checks passed!");
  } else {
    console.log("\n  ❌ Some referential integrity issues found — review above warnings.");
  }

  console.log("\nDone!");
  await pgPool.end();
  process.exit(0);
}

migrate().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
