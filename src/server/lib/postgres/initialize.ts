import { pool } from "./client";
import { searchUser, indexUser } from "./users";

export const version = "6";
export const index = "budget" + (version ? `-${version}` : "");

/**
 * Creates all necessary tables if they don't exist.
 * Then creates or updates admin user with configured password.
 */
export const initializeIndex = async (): Promise<void> => {
  console.info("Initialization started.");

  try {
    // Test connection
    const client = await pool.connect();
    client.release();
    console.info("PostgreSQL connection established.");
  } catch (error: any) {
    console.info(`PostgreSQL connection failed: ${error.message}`);
    console.info("Restarting initialization in 10 seconds.");
    return new Promise((res) => {
      setTimeout(() => res(initializeIndex()), 10000);
    });
  }

  try {
    // Create tables
    await pool.query(`
      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255),
        email VARCHAR(255),
        expiry TIMESTAMP,
        token VARCHAR(255),
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Sessions table
      CREATE TABLE IF NOT EXISTS sessions (
        session_id VARCHAR(255) PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Items table
      CREATE TABLE IF NOT EXISTS items (
        item_id VARCHAR(255) PRIMARY KEY,
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        data JSONB DEFAULT '{}',
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_items_user_id ON items(user_id);

      -- Institutions table
      CREATE TABLE IF NOT EXISTS institutions (
        institution_id VARCHAR(255) PRIMARY KEY,
        data JSONB DEFAULT '{}',
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Accounts table
      CREATE TABLE IF NOT EXISTS accounts (
        account_id VARCHAR(255) PRIMARY KEY,
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        balances JSONB DEFAULT '{}',
        label JSONB DEFAULT '{}',
        graph_options JSONB DEFAULT '{}',
        data JSONB DEFAULT '{}',
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
      CREATE INDEX IF NOT EXISTS idx_accounts_item_id ON accounts((data->>'item_id'));

      -- Holdings table
      CREATE TABLE IF NOT EXISTS holdings (
        holding_id VARCHAR(255) PRIMARY KEY,
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        data JSONB DEFAULT '{}',
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_holdings_user_id ON holdings(user_id);
      CREATE INDEX IF NOT EXISTS idx_holdings_account_id ON holdings((data->>'account_id'));

      -- Securities table
      CREATE TABLE IF NOT EXISTS securities (
        security_id VARCHAR(255) PRIMARY KEY,
        data JSONB DEFAULT '{}',
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Transactions table
      CREATE TABLE IF NOT EXISTS transactions (
        transaction_id VARCHAR(255) PRIMARY KEY,
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        label JSONB DEFAULT '{}',
        data JSONB DEFAULT '{}',
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_account_id ON transactions((data->>'account_id'));
      CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions((data->>'date'));

      -- Investment Transactions table
      CREATE TABLE IF NOT EXISTS investment_transactions (
        investment_transaction_id VARCHAR(255) PRIMARY KEY,
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        data JSONB DEFAULT '{}',
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_investment_transactions_user_id ON investment_transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_investment_transactions_account_id ON investment_transactions((data->>'account_id'));

      -- Split Transactions table
      CREATE TABLE IF NOT EXISTS split_transactions (
        split_transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        transaction_id VARCHAR(255),
        account_id VARCHAR(255),
        amount DECIMAL(15, 2) DEFAULT 0,
        date TIMESTAMP,
        custom_name TEXT DEFAULT '',
        label JSONB DEFAULT '{}',
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_split_transactions_user_id ON split_transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_split_transactions_transaction_id ON split_transactions(transaction_id);
      CREATE INDEX IF NOT EXISTS idx_split_transactions_account_id ON split_transactions(account_id);

      -- Budgets table
      CREATE TABLE IF NOT EXISTS budgets (
        budget_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        name VARCHAR(255) DEFAULT 'Unnamed',
        iso_currency_code VARCHAR(10) DEFAULT 'USD',
        capacities JSONB DEFAULT '[]',
        roll_over BOOLEAN DEFAULT FALSE,
        roll_over_start_date TIMESTAMP,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_budgets_user_id ON budgets(user_id);

      -- Sections table
      CREATE TABLE IF NOT EXISTS sections (
        section_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        budget_id UUID REFERENCES budgets(budget_id) ON DELETE CASCADE,
        name VARCHAR(255) DEFAULT 'Unnamed',
        capacities JSONB DEFAULT '[]',
        roll_over BOOLEAN DEFAULT FALSE,
        roll_over_start_date TIMESTAMP,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_sections_user_id ON sections(user_id);
      CREATE INDEX IF NOT EXISTS idx_sections_budget_id ON sections(budget_id);

      -- Categories table
      CREATE TABLE IF NOT EXISTS categories (
        category_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        section_id UUID REFERENCES sections(section_id) ON DELETE CASCADE,
        name VARCHAR(255) DEFAULT 'Unnamed',
        capacities JSONB DEFAULT '[]',
        roll_over BOOLEAN DEFAULT FALSE,
        roll_over_start_date TIMESTAMP,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_categories_user_id ON categories(user_id);
      CREATE INDEX IF NOT EXISTS idx_categories_section_id ON categories(section_id);

      -- Snapshots table
      CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id VARCHAR(255) PRIMARY KEY,
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        snapshot_date TIMESTAMP,
        snapshot_type VARCHAR(50) NOT NULL,
        data JSONB DEFAULT '{}',
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_user_id ON snapshots(user_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_type ON snapshots(snapshot_type);
      CREATE INDEX IF NOT EXISTS idx_snapshots_date ON snapshots(snapshot_date);

      -- Charts table
      CREATE TABLE IF NOT EXISTS charts (
        chart_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        name VARCHAR(255) DEFAULT 'Unnamed',
        type VARCHAR(50),
        configuration TEXT,
        updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_charts_user_id ON charts(user_id);
    `);

    console.info("Database tables created/verified successfully.");
  } catch (error: any) {
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
