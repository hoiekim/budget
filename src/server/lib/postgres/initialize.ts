import { pool } from "./client";
import { searchUser, indexUser } from "./users";

export const version = "6";
export const index = "budget" + (version ? `-${version}` : "");

/**
 * Creates all necessary tables if they don't exist.
 * Uses flattened column structure for partial updates (no JSONB for nested objects).
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
    // Create tables with flattened column structure
    await pool.query(`
      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255),
        email VARCHAR(255),
        expiry TIMESTAMP,
        token VARCHAR(255),
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_deleted BOOLEAN DEFAULT FALSE
      );

      -- Sessions table
      CREATE TABLE IF NOT EXISTS sessions (
        session_id VARCHAR(255) PRIMARY KEY,
        data JSONB DEFAULT '{}'::jsonb,
        user_user_id UUID,
        user_username VARCHAR(255),
        cookie_original_max_age BIGINT,
        cookie_max_age BIGINT,
        cookie_signed BOOLEAN,
        cookie_expires TIMESTAMP,
        cookie_http_only BOOLEAN,
        cookie_path TEXT,
        cookie_domain TEXT,
        cookie_secure VARCHAR(50),
        cookie_same_site VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Items table (Plaid items)
      CREATE TABLE IF NOT EXISTS items (
        item_id VARCHAR(255) PRIMARY KEY,
        user_id UUID REFERENCES users(user_id) ON DELETE RESTRICT,
        access_token VARCHAR(255),
        institution_id VARCHAR(255),
        available_products TEXT[],
        cursor TEXT,
        status VARCHAR(50),
        provider VARCHAR(50),
        raw JSONB,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_deleted BOOLEAN DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_items_user_id ON items(user_id);
      CREATE INDEX IF NOT EXISTS idx_items_institution_id ON items(institution_id);

      -- Institutions table
      CREATE TABLE IF NOT EXISTS institutions (
        institution_id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255),
        raw JSONB,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Accounts table (hybrid: indexed columns + raw JSONB)
      CREATE TABLE IF NOT EXISTS accounts (
        account_id VARCHAR(255) PRIMARY KEY,
        user_id UUID REFERENCES users(user_id) ON DELETE RESTRICT,
        item_id VARCHAR(255),
        institution_id VARCHAR(255),
        name VARCHAR(255),
        type VARCHAR(50),
        subtype VARCHAR(100),
        custom_name TEXT,
        hide BOOLEAN DEFAULT FALSE,
        label_budget_id UUID,
        graph_options_use_snapshots BOOLEAN DEFAULT TRUE,
        graph_options_use_transactions BOOLEAN DEFAULT TRUE,
        raw JSONB,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_deleted BOOLEAN DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
      CREATE INDEX IF NOT EXISTS idx_accounts_item_id ON accounts(item_id);
      CREATE INDEX IF NOT EXISTS idx_accounts_institution_id ON accounts(institution_id);

      -- Holdings table (hybrid: indexed columns + raw JSONB)
      CREATE TABLE IF NOT EXISTS holdings (
        holding_id VARCHAR(255) PRIMARY KEY,
        user_id UUID REFERENCES users(user_id) ON DELETE RESTRICT,
        account_id VARCHAR(255),
        security_id VARCHAR(255),
        institution_price DECIMAL(15, 6),
        institution_value DECIMAL(15, 2),
        cost_basis DECIMAL(15, 2),
        quantity DECIMAL(15, 6),
        iso_currency_code VARCHAR(10),
        raw JSONB,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_deleted BOOLEAN DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_holdings_user_id ON holdings(user_id);
      CREATE INDEX IF NOT EXISTS idx_holdings_account_id ON holdings(account_id);
      CREATE INDEX IF NOT EXISTS idx_holdings_security_id ON holdings(security_id);

      -- Securities table (hybrid: indexed columns + raw JSONB)
      CREATE TABLE IF NOT EXISTS securities (
        security_id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255),
        ticker_symbol VARCHAR(50),
        type VARCHAR(50),
        close_price DECIMAL(15, 6),
        close_price_as_of TIMESTAMP,
        iso_currency_code VARCHAR(10),
        isin VARCHAR(50),
        cusip VARCHAR(50),
        raw JSONB,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Transactions table (hybrid: indexed columns + raw JSONB)
      CREATE TABLE IF NOT EXISTS transactions (
        transaction_id VARCHAR(255) PRIMARY KEY,
        user_id UUID REFERENCES users(user_id) ON DELETE RESTRICT,
        account_id VARCHAR(255),
        name TEXT,
        amount DECIMAL(15, 2),
        date DATE,
        pending BOOLEAN DEFAULT FALSE,
        label_budget_id UUID,
        label_category_id UUID,
        label_memo TEXT,
        raw JSONB,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_deleted BOOLEAN DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_account_id ON transactions(account_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
      CREATE INDEX IF NOT EXISTS idx_transactions_pending ON transactions(pending);

      -- Investment Transactions table (hybrid: indexed columns + raw JSONB)
      CREATE TABLE IF NOT EXISTS investment_transactions (
        investment_transaction_id VARCHAR(255) PRIMARY KEY,
        user_id UUID REFERENCES users(user_id) ON DELETE RESTRICT,
        account_id VARCHAR(255),
        security_id VARCHAR(255),
        date DATE,
        name TEXT,
        amount DECIMAL(15, 2),
        quantity DECIMAL(15, 6),
        price DECIMAL(15, 6),
        type VARCHAR(50),
        raw JSONB,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_deleted BOOLEAN DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_investment_transactions_user_id ON investment_transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_investment_transactions_account_id ON investment_transactions(account_id);
      CREATE INDEX IF NOT EXISTS idx_investment_transactions_date ON investment_transactions(date);

      -- Split Transactions table (flattened label)
      CREATE TABLE IF NOT EXISTS split_transactions (
        split_transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE RESTRICT,
        transaction_id VARCHAR(255),
        account_id VARCHAR(255),
        amount DECIMAL(15, 2) DEFAULT 0,
        date DATE,
        custom_name TEXT DEFAULT '',
        -- Flattened label
        label_budget_id UUID,
        label_category_id UUID,
        label_memo TEXT,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_deleted BOOLEAN DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_split_transactions_user_id ON split_transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_split_transactions_transaction_id ON split_transactions(transaction_id);
      CREATE INDEX IF NOT EXISTS idx_split_transactions_account_id ON split_transactions(account_id);

      -- Budgets table
      CREATE TABLE IF NOT EXISTS budgets (
        budget_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE RESTRICT,
        name VARCHAR(255) DEFAULT 'Unnamed',
        iso_currency_code VARCHAR(10) DEFAULT 'USD',
        roll_over BOOLEAN DEFAULT FALSE,
        roll_over_start_date DATE,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_deleted BOOLEAN DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_budgets_user_id ON budgets(user_id);

      -- Sections table
      CREATE TABLE IF NOT EXISTS sections (
        section_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE RESTRICT,
        budget_id UUID REFERENCES budgets(budget_id) ON DELETE RESTRICT,
        name VARCHAR(255) DEFAULT 'Unnamed',
        roll_over BOOLEAN DEFAULT FALSE,
        roll_over_start_date DATE,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_deleted BOOLEAN DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_sections_user_id ON sections(user_id);
      CREATE INDEX IF NOT EXISTS idx_sections_budget_id ON sections(budget_id);

      -- Categories table
      CREATE TABLE IF NOT EXISTS categories (
        category_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE RESTRICT,
        section_id UUID REFERENCES sections(section_id) ON DELETE RESTRICT,
        name VARCHAR(255) DEFAULT 'Unnamed',
        roll_over BOOLEAN DEFAULT FALSE,
        roll_over_start_date DATE,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_deleted BOOLEAN DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_categories_user_id ON categories(user_id);
      CREATE INDEX IF NOT EXISTS idx_categories_section_id ON categories(section_id);

      -- Capacities table (extracted from budgets/sections/categories JSONB)
      CREATE TABLE IF NOT EXISTS capacities (
        capacity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE RESTRICT,
        parent_id UUID NOT NULL,
        parent_type VARCHAR(20) NOT NULL CHECK (parent_type IN ('budget', 'section', 'category')),
        month DECIMAL(15, 2) DEFAULT 0,
        active_from DATE,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_deleted BOOLEAN DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_capacities_user_id ON capacities(user_id);
      CREATE INDEX IF NOT EXISTS idx_capacities_parent ON capacities(parent_id, parent_type);

      -- Snapshots table (stores account, security, holding snapshots)
      CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id VARCHAR(255) PRIMARY KEY,
        user_id UUID,
        snapshot_date TIMESTAMP,
        snapshot_type VARCHAR(50) NOT NULL,
        -- For account snapshots (flattened balances)
        account_id VARCHAR(255),
        balances_available DECIMAL(15, 2),
        balances_current DECIMAL(15, 2),
        balances_limit DECIMAL(15, 2),
        balances_iso_currency_code VARCHAR(10),
        -- For security snapshots
        security_id VARCHAR(255),
        close_price DECIMAL(15, 6),
        -- For holding snapshots
        holding_account_id VARCHAR(255),
        holding_security_id VARCHAR(255),
        institution_price DECIMAL(15, 6),
        institution_value DECIMAL(15, 2),
        cost_basis DECIMAL(15, 2),
        quantity DECIMAL(15, 6),
        -- Metadata
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_deleted BOOLEAN DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_user_id ON snapshots(user_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_type ON snapshots(snapshot_type);
      CREATE INDEX IF NOT EXISTS idx_snapshots_date ON snapshots(snapshot_date);
      CREATE INDEX IF NOT EXISTS idx_snapshots_account_id ON snapshots(account_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_security_id ON snapshots(security_id);

      -- Charts table
      CREATE TABLE IF NOT EXISTS charts (
        chart_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE RESTRICT,
        name VARCHAR(255) DEFAULT 'Unnamed',
        type VARCHAR(50),
        configuration TEXT,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_deleted BOOLEAN DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_charts_user_id ON charts(user_id);
    `);

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
