//! Plaid: `src/server/lib/plaid/`. <https://plaid.com/docs/api/>

pub mod accounts;
pub mod institutions;
pub mod tokens;
pub mod transactions;
pub mod util;
pub mod webhook;

pub use accounts::{get_accounts, get_holdings, PlaidAccountsResponse, PlaidHoldingsResponse};
pub use institutions::get_institutions_by_ids;
pub use tokens::{delete_item, exchange_public_token, get_item, get_link_token};
pub use transactions::{get_investment_transactions, get_transactions, PlaidInvestmentTransactionsResponse, PlaidTransactionsResponse};
pub use util::{get_client, get_production_client, is_plaid_configured, PlaidClient, PlaidError, IGNORABLE_ERROR_CODES};
pub use webhook::{verify_webhook, WebhookVerification};
