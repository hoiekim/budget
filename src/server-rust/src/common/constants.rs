//! Names both the server and the client reference: `src/common/constants.ts`
//! and `src/common/transfers.ts`.

pub const USERS: &str = "users";
pub const SESSIONS: &str = "sessions";
pub const ITEMS: &str = "items";
pub const INSTITUTIONS: &str = "institutions";
pub const ACCOUNTS: &str = "accounts";
pub const HOLDINGS: &str = "holdings";
pub const SECURITIES: &str = "securities";
pub const TRANSACTIONS: &str = "transactions";
pub const INVESTMENT_TRANSACTIONS: &str = "investment_transactions";
pub const SPLIT_TRANSACTIONS: &str = "split_transactions";
pub const TRANSACTION_PAIRS: &str = "transaction_pairs";
pub const RECURRINGS: &str = "recurrings";
pub const BUDGETS: &str = "budgets";
pub const SECTIONS: &str = "sections";
pub const CATEGORIES: &str = "categories";
pub const SNAPSHOTS: &str = "snapshots";
pub const CHARTS: &str = "charts";
pub const API_KEYS: &str = "api_keys";
pub const REJECTED_CATEGORIES: &str = "rejected_categories";
pub const CPI_SNAPSHOTS: &str = "cpi_snapshots";

/// Id prefix of the holding snapshots the client derives from a holding's transactions.
pub const DERIVED_HOLDING_SNAPSHOT_PREFIX: &str = "derived-holding-";

/// Id prefix of investment transactions imported from a plan statement.
pub const PLAN_STATEMENT_ID_PREFIX: &str = "plan-";

/// Key on an investment transaction's `raw` marking a row restated from a
/// collective trust into shares of the public fund it tracks.
pub const RESTATED_FROM: &str = "restated_from";

/// Key on the `raw` of a reinvestment the plan-statement import inferred for a restated holding.
pub const REINVESTED_DISTRIBUTION: &str = "reinvested_distribution";

pub const BUDGET_NAME_REQUIRED_MESSAGE: &str = "Budget name cannot be empty.";
pub const SECTION_NAME_REQUIRED_MESSAGE: &str = "Section name cannot be empty.";
pub const CATEGORY_NAME_REQUIRED_MESSAGE: &str = "Category name cannot be empty.";

/// The index fund the Investment Performance widget compares returns against.
pub const BENCHMARK_TICKER: &str = "VOO";

/// The last row of the benchmark's static daily history (`voo_price_history.csv`).
pub const BENCHMARK_HISTORY_THROUGH: &str = "2026-10-13";

/// The query parameter that brings a failed single sign-on back to the sign-in page.
pub const SSO_ERROR_PARAM: &str = "sso_error";

/// Why a single sign-on came back to the sign-in page, as `SSO_ERROR_PARAM` carries it.
pub mod sso_error {
    /// The username is taken by a local account that is not linked to this person.
    pub const ACCOUNT_EXISTS: &str = "account_exists";
    /// The identity provider grants this person no access to the app.
    pub const NO_ACCESS: &str = "no_access";
    /// The sign-in took too long, or started in another browser.
    pub const EXPIRED: &str = "expired";
    /// The identity provider could not be reached.
    pub const UNAVAILABLE: &str = "unavailable";
    /// The identity provider's answer did not check out.
    pub const FAILED: &str = "failed";
}

/// The window, in days, within which two transactions can be one transfer.
pub const TRANSFER_DATE_WINDOW_DAYS: i64 = 7;
