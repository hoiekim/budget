//! Table definitions: schema, row checks and JSON shapes, one module per
//! table as in `src/server/lib/postgres/models/`.

pub mod account;
pub mod api_key;
pub mod base;
pub mod budget;
pub mod category;
pub mod chart;
pub mod common;
pub mod cpi_snapshot;
pub mod holding;
pub mod institution;
pub mod investment_transaction;
pub mod item;
pub mod recurring;
pub mod rejected_category;
pub mod section;
pub mod security;
pub mod session;
pub mod snapshot;
pub mod split_transaction;
pub mod transaction;
pub mod transaction_pair;
pub mod user;

#[cfg(test)]
mod base_test;
mod js_object;

pub use base::{Check, IndexDefinition, IndexKey, ModelValidationError, Row, Table, UpdateArgs, STREAM_BATCH_SIZE};
pub use session::{SessionAuth, SessionCookie, SessionData};
pub use user::{MaskedUser, User};

/// Every table, in the order they are created at start: a table comes after
/// the ones its columns reference.
pub fn tables() -> Vec<&'static Table> {
    vec![
        &user::TABLE,
        &session::TABLE,
        &institution::TABLE,
        &security::TABLE,
        &item::TABLE,
        &account::TABLE,
        &holding::TABLE,
        &transaction::TABLE,
        &transaction_pair::TABLE,
        &recurring::TABLE,
        &investment_transaction::TABLE,
        &split_transaction::TABLE,
        &budget::TABLE,
        &section::TABLE,
        &category::TABLE,
        &snapshot::TABLE,
        &chart::TABLE,
        &api_key::TABLE,
        &rejected_category::TABLE,
        &cpi_snapshot::TABLE,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn columns_of(index: &IndexDefinition) -> Vec<&'static str> {
        match index.key {
            IndexKey::Column(column) => vec![column],
            IndexKey::Columns(columns) => columns.to_vec(),
            IndexKey::Expression { expression, .. } => vec![expression],
        }
    }

    // The `tables` array of `src/server/lib/postgres/initialize.ts`.
    #[test]
    fn tables_are_created_in_the_order_the_typescript_creates_them() {
        let names: Vec<&str> = tables().iter().map(|table| table.name).collect();
        assert_eq!(
            names,
            [
                "users",
                "sessions",
                "institutions",
                "securities",
                "items",
                "accounts",
                "holdings",
                "transactions",
                "transaction_pairs",
                "recurrings",
                "investment_transactions",
                "split_transactions",
                "budgets",
                "sections",
                "categories",
                "snapshots",
                "charts",
                "api_keys",
                "rejected_categories",
                "cpi_snapshots",
            ]
        );
    }

    #[test]
    fn a_table_references_only_tables_created_before_it() {
        let tables = tables();
        for (position, table) in tables.iter().enumerate() {
            for (column, definition) in table.schema {
                let Some(rest) = definition.split("REFERENCES ").nth(1) else { continue };
                let referenced = rest.split('(').next().unwrap();
                let created_before = tables[..position].iter().any(|earlier| earlier.name == referenced);
                assert!(created_before, "{}.{column} references {referenced}, which is not created yet", table.name);
            }
        }
    }

    #[test]
    fn every_table_checks_exactly_its_columns_and_has_its_primary_key() {
        for table in tables() {
            let checked: Vec<&str> = table.checks.iter().map(|(column, _)| *column).collect();
            assert_eq!(checked, table.columns(), "{}", table.name);
            assert!(table.columns().contains(&table.primary_key), "{}", table.name);
            let soft_deletes = table.columns().contains(&"is_deleted");
            assert_eq!(table.supports_soft_delete, soft_deletes, "{}", table.name);
        }
    }

    // `indexes.test.ts`, "index definitions carry no leftmost-prefix redundancy".

    // A btree on (a, b) already serves every `WHERE a = ?` lookup as a
    // leftmost-prefix scan, so a standalone (a) alongside it is pure write
    // amplification. Asserted across every table, so a new composite cannot
    // reintroduce the pattern.
    #[test]
    fn no_table_has_a_single_column_index_that_is_the_leftmost_prefix_of_a_composite() {
        for table in tables() {
            let indexes: Vec<Vec<&str>> = table.indexes.iter().map(columns_of).collect();
            let composites: Vec<&Vec<&str>> = indexes.iter().filter(|columns| columns.len() > 1).collect();
            let redundant: Vec<&str> = indexes
                .iter()
                .filter(|columns| columns.len() == 1)
                .map(|columns| columns[0])
                .filter(|column| composites.iter().any(|composite| composite[0] == *column))
                .collect();
            assert!(redundant.is_empty(), "{}: {redundant:?}", table.name);
        }
    }

    // The other half of the invariant: dropping the standalone `user_id`
    // entries is only safe while the composite that subsumes them exists.
    #[test]
    fn delta_synced_tables_still_index_user_id_via_the_user_id_updated_composite() {
        for table in [
            &transaction::TABLE,
            &investment_transaction::TABLE,
            &split_transaction::TABLE,
            &snapshot::TABLE,
            &transaction_pair::TABLE,
        ] {
            let indexes: Vec<Vec<&str>> = table.indexes.iter().map(columns_of).collect();
            assert!(indexes.contains(&vec![common::USER_ID, common::UPDATED]), "{}", table.name);
        }
    }
}
