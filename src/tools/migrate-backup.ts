/**
 * Migration script to import backed up JSONB data into the new flattened schema.
 */

import { readFileSync } from "fs";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://localhost:5432/budget",
});

async function migrateUsers() {
  const lines = readFileSync("backup_users.json", "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    const row = JSON.parse(line);
    const data = row.data || {};
    const username = data.username || row.username;
    const password = data.password || row.password;
    
    try {
      await pool.query(
        `INSERT INTO users (user_id, username, password, updated) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET password = EXCLUDED.password, updated = EXCLUDED.updated`,
        [row.user_id, username, password, row.updated]
      );
    } catch (err: any) {
      // If username conflict, try to update
      console.log(`User insert failed for ${username}, trying update: ${err.message}`);
    }
  }
  console.log(`Migrated ${lines.length} users`);
}

async function migrateItems() {
  const lines = readFileSync("backup_items.json", "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    const row = JSON.parse(line);
    const data = row.data || {};
    await pool.query(
      `INSERT INTO items (
        item_id, user_id, access_token, institution_id, provider, status, cursor,
        available_products, updated, is_deleted
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (item_id) DO NOTHING`,
      [
        row.item_id || data.item_id,
        row.user_id || data.user_id,
        data.access_token,
        data.institution_id,
        data.provider,
        data.status,
        data.cursor,
        data.available_products || [],
        row.updated,
        false,
      ]
    );
  }
  console.log(`Migrated ${lines.length} items`);
}

async function migrateInstitutions() {
  const lines = readFileSync("backup_institutions.json", "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    const row = JSON.parse(line);
    const data = row.data || {};
    await pool.query(
      `INSERT INTO institutions (
        institution_id, name, url, logo, products, country_codes, routing_numbers, oauth, updated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (institution_id) DO NOTHING`,
      [
        row.institution_id || data.institution_id,
        data.name,
        data.url,
        data.logo,
        data.products || [],
        data.country_codes || [],
        data.routing_numbers || [],
        data.oauth,
        row.updated,
      ]
    );
  }
  console.log(`Migrated ${lines.length} institutions`);
}

async function migrateAccounts() {
  const lines = readFileSync("backup_accounts.json", "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    const row = JSON.parse(line);
    const data = row.data || {};
    const balances = data.balances || {};
    const label = data.label || {};
    const graphOptions = data.graphOptions || {};
    
    await pool.query(
      `INSERT INTO accounts (
        account_id, user_id, item_id, institution_id, name, official_name, type, subtype, mask,
        balances_available, balances_current, balances_limit, balances_iso_currency_code,
        custom_name, hide, label_budget_id, graph_options_use_snapshots, graph_options_use_transactions,
        updated, is_deleted
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       ON CONFLICT (account_id) DO NOTHING`,
      [
        row.account_id || data.account_id,
        row.user_id || data.user_id,
        data.item_id,
        data.institution_id,
        data.name,
        data.official_name,
        data.type,
        data.subtype,
        data.mask,
        balances.available,
        balances.current,
        balances.limit,
        balances.iso_currency_code,
        data.custom_name,
        data.hide,
        label.budget_id,
        graphOptions.useSnapshots !== false,
        graphOptions.useTransactions !== false,
        row.updated,
        false,
      ]
    );
  }
  console.log(`Migrated ${lines.length} accounts`);
}

async function migrateSecurities() {
  const lines = readFileSync("backup_securities.json", "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    const row = JSON.parse(line);
    const data = row.data || {};
    await pool.query(
      `INSERT INTO securities (
        security_id, name, ticker_symbol, isin, cusip, sedol, close_price, close_price_as_of,
        iso_currency_code, type, is_cash_equivalent, updated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (security_id) DO NOTHING`,
      [
        row.security_id || data.security_id,
        data.name,
        data.ticker_symbol,
        data.isin,
        data.cusip,
        data.sedol,
        data.close_price,
        data.close_price_as_of,
        data.iso_currency_code,
        data.type,
        data.is_cash_equivalent,
        row.updated,
      ]
    );
  }
  console.log(`Migrated ${lines.length} securities`);
}

async function migrateHoldings() {
  const lines = readFileSync("backup_holdings.json", "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    const row = JSON.parse(line);
    const data = row.data || {};
    await pool.query(
      `INSERT INTO holdings (
        holding_id, user_id, account_id, security_id, institution_price, institution_price_as_of,
        institution_value, cost_basis, quantity, iso_currency_code, updated, is_deleted
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (holding_id) DO NOTHING`,
      [
        row.holding_id || data.holding_id,
        row.user_id || data.user_id,
        data.account_id,
        data.security_id,
        data.institution_price,
        data.institution_price_as_of,
        data.institution_value,
        data.cost_basis,
        data.quantity,
        data.iso_currency_code,
        row.updated,
        false,
      ]
    );
  }
  console.log(`Migrated ${lines.length} holdings`);
}

async function migrateTransactions() {
  const lines = readFileSync("backup_transactions.json", "utf-8").split("\n").filter(Boolean);
  let count = 0;
  for (const line of lines) {
    const row = JSON.parse(line);
    const data = row.data || {};
    const label = data.label || {};
    const location = data.location || {};
    const paymentMeta = data.payment_meta || {};
    
    await pool.query(
      `INSERT INTO transactions (
        transaction_id, user_id, account_id, pending_transaction_id, name,
        amount, iso_currency_code, date, authorized_date, pending, transaction_code,
        payment_channel, category, category_id,
        location_address, location_city, location_region, location_postal_code,
        location_country, location_lat, location_lon, location_store_number,
        payment_meta_reference_number, payment_meta_ppd_id, payment_meta_payee,
        label_budget_id, label_category_id, label_memo, updated, is_deleted
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)
       ON CONFLICT (transaction_id) DO NOTHING`,
      [
        row.transaction_id || data.transaction_id,
        row.user_id || data.user_id,
        data.account_id,
        data.pending_transaction_id,
        data.name,
        data.amount,
        data.iso_currency_code,
        data.date,
        data.authorized_date,
        data.pending,
        data.transaction_code,
        data.payment_channel,
        Array.isArray(data.category) ? data.category : (data.category ? [data.category] : []),
        data.category_id,
        location.address,
        location.city,
        location.region,
        location.postal_code,
        location.country,
        location.lat,
        location.lon,
        location.store_number,
        paymentMeta.reference_number,
        paymentMeta.ppd_id,
        paymentMeta.payee,
        label.budget_id,
        label.category_id,
        label.memo,
        row.updated,
        false,
      ]
    );
    count++;
    if (count % 1000 === 0) console.log(`  ...${count} transactions`);
  }
  console.log(`Migrated ${lines.length} transactions`);
}

async function migrateInvestmentTransactions() {
  const lines = readFileSync("backup_investment_transactions.json", "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    const row = JSON.parse(line);
    const data = row.data || {};
    
    await pool.query(
      `INSERT INTO investment_transactions (
        investment_transaction_id, user_id, account_id, security_id, name, amount, price,
        quantity, fees, date, type, subtype, iso_currency_code, updated, is_deleted
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (investment_transaction_id) DO NOTHING`,
      [
        row.investment_transaction_id || data.investment_transaction_id,
        row.user_id || data.user_id,
        data.account_id,
        data.security_id,
        data.name,
        data.amount,
        data.price,
        data.quantity,
        data.fees,
        data.date,
        data.type,
        data.subtype,
        data.iso_currency_code,
        row.updated,
        false,
      ]
    );
  }
  console.log(`Migrated ${lines.length} investment_transactions`);
}

async function migrateSplitTransactions() {
  const lines = readFileSync("backup_split_transactions.json", "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    const row = JSON.parse(line);
    const data = row.data || {};
    const label = data.label || {};
    
    // split_transaction_id is UUID in new schema, let PostgreSQL generate it
    await pool.query(
      `INSERT INTO split_transactions (
        user_id, transaction_id, account_id, amount, date,
        custom_name, label_budget_id, label_category_id, label_memo, updated, is_deleted
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        row.user_id || data.user_id,
        data.transaction_id,
        data.account_id,
        data.amount,
        data.date,
        data.custom_name || '',
        label.budget_id,
        label.category_id,
        label.memo,
        row.updated,
        false,
      ]
    );
  }
  console.log(`Migrated ${lines.length} split_transactions`);
}

async function migrateBudgets() {
  const lines = readFileSync("backup_budgets.json", "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    const row = JSON.parse(line);
    const data = row.data || {};
    
    await pool.query(
      `INSERT INTO budgets (
        budget_id, user_id, name, iso_currency_code, capacities, roll_over, roll_over_start_date, updated, is_deleted
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (budget_id) DO NOTHING`,
      [
        row.budget_id || data.budget_id,
        row.user_id || data.user_id,
        data.name,
        data.iso_currency_code,
        JSON.stringify(data.capacities || []),
        data.roll_over,
        data.roll_over_start_date,
        row.updated,
        false,
      ]
    );
  }
  console.log(`Migrated ${lines.length} budgets`);
}

async function migrateSections() {
  const lines = readFileSync("backup_sections.json", "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    const row = JSON.parse(line);
    const data = row.data || {};
    
    await pool.query(
      `INSERT INTO sections (
        section_id, user_id, budget_id, name, capacities, roll_over, roll_over_start_date, updated, is_deleted
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (section_id) DO NOTHING`,
      [
        row.section_id || data.section_id,
        row.user_id || data.user_id,
        data.budget_id,
        data.name,
        JSON.stringify(data.capacities || []),
        data.roll_over,
        data.roll_over_start_date,
        row.updated,
        false,
      ]
    );
  }
  console.log(`Migrated ${lines.length} sections`);
}

async function migrateCategories() {
  const lines = readFileSync("backup_categories.json", "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    const row = JSON.parse(line);
    const data = row.data || {};
    
    await pool.query(
      `INSERT INTO categories (
        category_id, user_id, section_id, name, capacities, roll_over, roll_over_start_date, updated, is_deleted
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (category_id) DO NOTHING`,
      [
        row.category_id || data.category_id,
        row.user_id || data.user_id,
        data.section_id,
        data.name,
        JSON.stringify(data.capacities || []),
        data.roll_over,
        data.roll_over_start_date,
        row.updated,
        false,
      ]
    );
  }
  console.log(`Migrated ${lines.length} categories`);
}

async function migrateCharts() {
  const lines = readFileSync("backup_charts_fixed.json", "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    const row = JSON.parse(line);
    
    // Configuration may be a stringified JSON
    let configuration = row.configuration;
    if (typeof configuration === 'string') {
      try {
        configuration = JSON.parse(configuration);
      } catch {
        // Keep as string if parse fails
      }
    }
    
    await pool.query(
      `INSERT INTO charts (
        chart_id, user_id, name, type, configuration, updated, is_deleted
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chart_id) DO NOTHING`,
      [
        row.chart_id,
        row.user_id,
        row.name,
        row.type,
        JSON.stringify(configuration || {}),
        row.updated,
        false,
      ]
    );
  }
  console.log(`Migrated ${lines.length} charts`);
}

async function migrateSnapshots() {
  const lines = readFileSync("backup_snapshots.json", "utf-8").split("\n").filter(Boolean);
  let count = 0;
  for (const line of lines) {
    const row = JSON.parse(line);
    const data = row.data || {};
    const snapshot = data.snapshot || {};
    const account = data.account || {};
    const security = data.security || {};
    const holding = data.holding || {};
    
    // Determine snapshot type
    let snapshotType = "unknown";
    if (account.account_id) snapshotType = "account_balance";
    else if (security.security_id) snapshotType = "security";
    else if (holding.holding_id) snapshotType = "holding";
    
    await pool.query(
      `INSERT INTO snapshots (
        snapshot_id, user_id, snapshot_date, snapshot_type, account_id, security_id,
        holding_account_id, holding_security_id, balances_available, balances_current,
        balances_limit, balances_iso_currency_code, close_price, institution_price,
        institution_value, cost_basis, quantity, updated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (snapshot_id) DO NOTHING`,
      [
        row.snapshot_id || snapshot.snapshot_id,
        row.user_id || account.user_id || holding.user_id,
        snapshot.date,
        snapshotType,
        account.account_id,
        security.security_id,
        holding.account_id,
        holding.security_id,
        account.balances?.available,
        account.balances?.current,
        account.balances?.limit,
        account.balances?.iso_currency_code,
        security.close_price,
        holding.institution_price,
        holding.institution_value,
        holding.cost_basis,
        holding.quantity,
        row.updated,
      ]
    );
    count++;
    if (count % 1000 === 0) console.log(`  ...${count} snapshots`);
  }
  console.log(`Migrated ${lines.length} snapshots`);
}

async function main() {
  try {
    console.log("Starting migration from backup files to new schema...\n");
    
    await migrateUsers();
    await migrateInstitutions();
    await migrateItems();
    await migrateSecurities();
    await migrateAccounts();
    await migrateHoldings();
    await migrateTransactions();
    await migrateInvestmentTransactions();
    await migrateSplitTransactions();
    await migrateBudgets();
    await migrateSections();
    await migrateCategories();
    await migrateCharts();
    await migrateSnapshots();
    
    console.log("\nMigration complete!");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
