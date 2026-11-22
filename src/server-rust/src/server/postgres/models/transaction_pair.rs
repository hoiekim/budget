//! `src/server/lib/postgres/models/transaction_pair.ts`.

use super::base::{Check, IndexDefinition, Row, Table};
use super::js_object::Literal;
use crate::js::Json;

pub static TABLE: Table = Table {
    name: "transaction_pairs",
    primary_key: "pair_id",
    schema: &[
        ("pair_id", "UUID PRIMARY KEY"),
        ("user_id", "UUID REFERENCES users(user_id) ON DELETE RESTRICT NOT NULL"),
        ("transaction_id_a", "VARCHAR(255) NOT NULL REFERENCES transactions(transaction_id) ON DELETE CASCADE"),
        ("transaction_id_b", "VARCHAR(255) NOT NULL REFERENCES transactions(transaction_id) ON DELETE CASCADE"),
        ("status", "VARCHAR(20) NOT NULL"),
        ("created_at", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
        ("is_deleted", "BOOLEAN DEFAULT FALSE"),
    ],
    constraints: &["CONSTRAINT transaction_pairs_pair_unique UNIQUE (transaction_id_a, transaction_id_b)"],
    indexes: &[
        IndexDefinition::column("transaction_id_a"),
        IndexDefinition::column("transaction_id_b"),
        // Matches the delta-by-cursor read pattern the sync path now uses:
        // `WHERE user_id = $1 AND updated >= $cursor`. Same shape every other
        // delta-fetched table carries (transactions, split_transactions,
        // investment_transactions, snapshots). Without this, the
        // planner does a user_id lookup then scans + filters all of that user's
        // pairs: O(all-pairs-for-user), not O(rows-changed).
        // Also the only `user_id` index this table needs: a `user_id`-only lookup is a
        // leftmost-prefix scan of this composite.
        IndexDefinition::columns(&["user_id", "updated"]),
    ],
    model: "TransactionPairModel",
    checks: &[
        ("pair_id", Check::String),
        ("user_id", Check::String),
        ("transaction_id_a", Check::String),
        ("transaction_id_b", Check::String),
        ("status", Check::String),
        ("created_at", Check::NullableString),
        ("updated", Check::NullableString),
        ("is_deleted", Check::NullableBoolean),
    ],
    supports_soft_delete: true,
};

/// `transactionPairColumns`.
pub fn columns() -> Vec<&'static str> {
    TABLE.columns()
}

/// `toJSON()`: a `JSONTransferPair`.
pub fn to_json(row: &Row) -> Json {
    Literal::new()
        .opt("pair_id", row.get("pair_id"))
        .opt("transaction_id_a", row.get("transaction_id_a"))
        .opt("transaction_id_b", row.get("transaction_id_b"))
        .opt("status", row.get("status"))
        .opt("updated", row.get("updated"))
        .into()
}

/// The two transactions of a pair in the order the table stores them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PairIds<'a> {
    pub transaction_id_a: &'a str,
    pub transaction_id_b: &'a str,
}

/// `canonicalizePairIds()`: orders the two ids so the same two always give
/// the same (a, b), which prevents duplicate pairs without a separate hash.
///
/// The order is JavaScript's `<` on strings, by UTF-16 code unit. Rust's own
/// string order is by code point, and the two disagree on a character outside
/// the Basic Multilingual Plane against one from U+E000 up.
pub fn canonicalize_pair_ids<'a>(id1: &'a str, id2: &'a str) -> PairIds<'a> {
    if id1.encode_utf16().lt(id2.encode_utf16()) {
        PairIds { transaction_id_a: id1, transaction_id_b: id2 }
    } else {
        PairIds { transaction_id_a: id2, transaction_id_b: id1 }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::js_object::testing::{assert_json, obj};
    use super::*;

    fn row() -> Json {
        json!({
            "pair_id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
            "user_id": "0b6d4a2e-6f0c-4a52-9c1f-5d1f6f1f3a10",
            "transaction_id_a": "tx-1",
            "transaction_id_b": "tx-2",
            "status": "suggested",
            "created_at": "2026-05-16T00:00:00.000Z",
            "updated": "2026-05-17T00:00:00.000Z",
            "is_deleted": false,
        })
    }

    #[test]
    fn to_json_leaves_out_the_owner_and_bookkeeping_columns() {
        let row = TABLE.validate(obj(row())).unwrap();
        assert_json(
            &to_json(&row),
            json!({
                "pair_id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
                "transaction_id_a": "tx-1",
                "transaction_id_b": "tx-2",
                "status": "suggested",
                "updated": "2026-05-17T00:00:00.000Z",
            }),
        );
    }

    #[test]
    fn to_json_keeps_a_null_updated() {
        let mut row = obj(row());
        row.insert("updated".into(), Json::Null);
        assert_eq!(to_json(&row).get("updated"), Some(&Json::Null));
    }

    // `repositories/transfers.test.ts`, "canonicalizePairIds".
    #[test]
    fn the_smaller_id_is_always_a() {
        assert_eq!(canonicalize_pair_ids("z", "a"), PairIds { transaction_id_a: "a", transaction_id_b: "z" });
        assert_eq!(canonicalize_pair_ids("a", "z"), PairIds { transaction_id_a: "a", transaction_id_b: "z" });
    }

    #[test]
    fn ids_compare_the_way_javascript_strings_do() {
        // A prefix sorts first; equal ids stay as given.
        assert_eq!(canonicalize_pair_ids("tx-10", "tx-1").transaction_id_a, "tx-1");
        assert_eq!(canonicalize_pair_ids("tx", "tx"), PairIds { transaction_id_a: "tx", transaction_id_b: "tx" });
        // U+1F600 is the surrogate pair D83D DE00 in UTF-16, below U+FF5E; by code point it is above.
        assert!("\u{1F600}" > "\u{FF5E}");
        assert_eq!(canonicalize_pair_ids("\u{FF5E}", "\u{1F600}").transaction_id_a, "\u{1F600}");
    }
}
