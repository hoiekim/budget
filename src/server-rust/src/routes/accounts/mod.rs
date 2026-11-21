//! Accounts and everything in them: transactions, snapshots, holdings, securities. `src/server/routes/accounts/`.

pub mod delete_account;
pub mod delete_holding_snapshot;
pub mod delete_investment_transaction;
pub mod delete_snapshot;
pub mod delete_split_transaction;
pub mod delete_transaction;
pub mod get_accounts;
pub mod get_daily_closes;
pub mod get_holding_snapshots;
pub mod get_institutions;
pub mod get_new_account;
pub mod get_new_investment_transaction;
pub mod get_new_split_transaction;
pub mod get_new_transaction;
pub mod get_securities;
pub mod get_snapshots;
pub mod get_split_transactions;
pub mod get_transactions;
pub mod post_account;
pub mod post_holding_snapshot;
pub mod post_investment_transaction;
pub mod post_plan_statement;
pub mod post_snapshot;
pub mod post_split_transaction;
pub mod post_suggest_category;
pub mod post_transaction;
pub mod post_validate_ticker;

use crate::server::route::Route;

pub fn routes() -> Vec<Route> {
    let mut routes = Vec::new();
    routes.extend(delete_account::routes());
    routes.extend(delete_holding_snapshot::routes());
    routes.extend(delete_investment_transaction::routes());
    routes.extend(delete_snapshot::routes());
    routes.extend(delete_split_transaction::routes());
    routes.extend(delete_transaction::routes());
    routes.extend(get_accounts::routes());
    routes.extend(get_daily_closes::routes());
    routes.extend(get_holding_snapshots::routes());
    routes.extend(get_institutions::routes());
    routes.extend(get_new_account::routes());
    routes.extend(get_new_investment_transaction::routes());
    routes.extend(get_new_split_transaction::routes());
    routes.extend(get_new_transaction::routes());
    routes.extend(get_securities::routes());
    routes.extend(get_snapshots::routes());
    routes.extend(get_split_transactions::routes());
    routes.extend(get_transactions::routes());
    routes.extend(post_account::routes());
    routes.extend(post_holding_snapshot::routes());
    routes.extend(post_investment_transaction::routes());
    routes.extend(post_plan_statement::routes());
    routes.extend(post_snapshot::routes());
    routes.extend(post_split_transaction::routes());
    routes.extend(post_suggest_category::routes());
    routes.extend(post_transaction::routes());
    routes.extend(post_validate_ticker::routes());
    routes
}
