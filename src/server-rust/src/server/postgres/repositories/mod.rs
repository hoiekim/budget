//! Higher-level data access over the table models, one module per
//! `src/server/lib/postgres/repositories/` file.

pub mod accounts;
pub mod api_keys;
pub mod budgets;
pub mod charts;
pub mod cpi_snapshots;
pub mod holdings;
pub mod institutions;
pub mod investment_transactions;
pub mod items;
pub mod recurrings;
pub mod rejected_categories;
pub mod securities;
pub mod session;
pub mod sharing;
pub mod snapshots;
pub mod split_transactions;
pub mod transactions;
pub mod transfers;
pub mod users;
