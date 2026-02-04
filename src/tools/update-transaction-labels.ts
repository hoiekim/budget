/**
 * Update Transaction Labels Tool
 * 
 * This script updates transaction labels from a JSON file containing
 * transaction_id to label mappings.
 * 
 * Usage:
 *   npx ts-node src/tools/update-transaction-labels.ts
 * 
 * Environment Variables:
 *   LABELS_JSON_FILE - Path to JSON file with label data (default: transaction_labels.json)
 * 
 * Expected JSON format (array of objects):
 * [
 *   {
 *     "transaction_id": "xxx",
 *     "label": {
 *       "budget_id": "uuid-or-null",
 *       "category_id": "uuid-or-null",
 *       "memo": "string-or-null"
 *     }
 *   },
 *   ...
 * ]
 * 
 * Or export from ES with:
 *   curl "http://192.168.0.112:9200/transactions/_search?size=10000" | jq '[.hits.hits[] | {transaction_id: ._source.transaction.transaction_id, label: ._source.transaction.label}]'
 */

import { Pool } from "pg";
import * as fs from "fs";
import * as path from "path";

interface LabelData {
  transaction_id: string;
  label?: {
    budget_id?: string | null;
    category_id?: string | null;
    memo?: string | null;
  };
}

// JSON file with label data
const LABELS_JSON_FILE = process.env.LABELS_JSON_FILE || path.join(__dirname, "../../transaction_labels.json");

// PostgreSQL configuration
const pgPool = new Pool({
  host: process.env.POSTGRES_HOST || "localhost",
  port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
  user: process.env.POSTGRES_USER || "hoiekim",
  password: process.env.POSTGRES_PASSWORD || "",
  database: process.env.POSTGRES_DATABASE || "budget",
});

// Statistics
let updated = 0;
let skipped = 0;
let errors = 0;

async function updateLabel(data: LabelData): Promise<void> {
  const { transaction_id, label } = data;
  
  if (!label || (!label.budget_id && !label.category_id && !label.memo)) {
    skipped++;
    return;
  }

  try {
    const result = await pgPool.query(
      `UPDATE transactions 
       SET label_budget_id = COALESCE($2, label_budget_id),
           label_category_id = COALESCE($3, label_category_id),
           label_memo = COALESCE($4, label_memo),
           updated = CURRENT_TIMESTAMP
       WHERE transaction_id = $1
       RETURNING transaction_id`,
      [
        transaction_id,
        label.budget_id || null,
        label.category_id || null,
        label.memo || null,
      ]
    );
    
    if (result.rowCount && result.rowCount > 0) {
      updated++;
    } else {
      skipped++;
    }
  } catch (error: any) {
    console.error(`Failed to update transaction ${transaction_id}:`, error.message);
    errors++;
  }
}

async function main(): Promise<void> {
  console.log("========================================");
  console.log("Update Transaction Labels Tool");
  console.log("========================================");
  console.log(`JSON File: ${LABELS_JSON_FILE}`);
  console.log("========================================\n");

  // Load JSON data
  console.log("Loading JSON data...");
  if (!fs.existsSync(LABELS_JSON_FILE)) {
    console.error(`JSON file not found: ${LABELS_JSON_FILE}`);
    console.log("\nTo export labels from ES, run:");
    console.log(`curl "http://192.168.0.112:9200/transactions/_search?size=10000" | jq '[.hits.hits[] | {transaction_id: ._source.transaction.transaction_id, label: ._source.transaction.label}]' > transaction_labels.json`);
    process.exit(1);
  }
  
  const jsonData = JSON.parse(fs.readFileSync(LABELS_JSON_FILE, "utf-8")) as LabelData[];
  console.log(`✓ Loaded ${jsonData.length} label entries from JSON file`);

  // Test PostgreSQL connection
  try {
    const client = await pgPool.connect();
    client.release();
    console.log("✓ PostgreSQL connection OK");
  } catch (error: any) {
    console.error("✗ PostgreSQL connection failed:", error.message);
    process.exit(1);
  }

  console.log(`\nUpdating labels for ${jsonData.length} transactions...\n`);

  let processed = 0;
  for (const data of jsonData) {
    await updateLabel(data);
    processed++;
    
    if (processed % 500 === 0) {
      console.log(`  Processed ${processed} / ${jsonData.length}...`);
    }
  }

  // Print summary
  console.log("\n========================================");
  console.log("Update Complete!");
  console.log("========================================");
  console.log(`Updated: ${updated}`);
  console.log(`Skipped (no label or not found): ${skipped}`);
  console.log(`Errors: ${errors}`);
  console.log("========================================\n");

  await pgPool.end();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Update failed:", error);
  process.exit(1);
});
