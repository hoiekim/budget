//! Table definitions: schema, row checks and JSON shapes, one module per
//! table as in `src/server/lib/postgres/models/`.

pub mod api_key;
pub mod base;
pub mod common;
pub mod session;
pub mod user;

pub use base::{Check, IndexDefinition, IndexKey, ModelValidationError, Row, Table, UpdateArgs, STREAM_BATCH_SIZE};
pub use session::{SessionAuth, SessionCookie, SessionData};
pub use user::{MaskedUser, User};

/// Every table, in the order they are created at start.
pub fn tables() -> Vec<&'static Table> {
    vec![&user::TABLE, &session::TABLE, &api_key::TABLE]
}
