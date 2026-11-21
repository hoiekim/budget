//! `src/server/lib/postgres/repositories/transactions.ts`. Not ported yet.
//!
//! TEMPORARY: `soft_delete_transaction_pairs_by_accounts` alone is here, a
//! copy made for the account and item repositories, which cascade through it.
//! The full port of `transactions.ts` replaces this file.

use serde_json::json;

use crate::js::Json;
use crate::server::postgres::client::Executor;
use crate::server::postgres::models::{transaction, transaction_pair, MaskedUser};

/// Soft-deletes every pair that references a transaction on one of `account_ids`.
///
/// A pair joins `transactions` by id, so a cascade that only knows accounts has
/// to travel through them. Left live, the surviving half stays bundled as a
/// transfer to an account that no longer exists, the detection engine treats it
/// as already-paired and will not re-suggest it, and an untouched `updated`
/// keeps any delta sync from correcting the client.
///
/// Call this AFTER the caller's `transactions` soft-delete: that UPDATE holds an
/// exclusive row lock until commit, which is what blocks a concurrent
/// `pair_transactions`, whose existence pre-check takes `FOR SHARE` on the same
/// rows, from minting a pair behind the cascade.
///
/// Both join columns, one statement each, whatever the account count.
pub async fn soft_delete_transaction_pairs_by_accounts(
    user: &MaskedUser,
    account_ids: &[String],
    client: Option<&dyn Executor>,
) -> anyhow::Result<()> {
    let match_values: Vec<Json> = account_ids.iter().map(|account_id| json!(account_id)).collect();
    for column in ["transaction_id_a", "transaction_id_b"] {
        transaction_pair::TABLE
            .bulk_soft_delete_by_related_column(
                column,
                transaction::TABLE.name,
                "transaction_id",
                "account_id",
                &match_values,
                Some(&user.user_id),
                client,
            )
            .await?;
    }
    Ok(())
}
