//! Data access: the pool, the generic query builders, table models and the
//! repositories over them. Mirrors `src/server/lib/postgres/`.

pub mod client;
pub mod database;
pub mod initialize;
pub mod migration;
pub mod models;
pub mod repositories;

pub use client::{or_pool, pool, sqlstate, with_transaction, Client, DbError, Executor, QueryResult};
pub use database::*;
pub use initialize::{initialize_postgres, VERSION};
