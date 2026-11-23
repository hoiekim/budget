//! The budget app's backend. Serves the same HTTP API, against the same
//! PostgreSQL schema, as the Bun backend in `src/server`; the layout mirrors
//! it module for module:
//!
//! - `server/…` is `src/server/lib/…`
//! - `routes/…` is `src/server/routes/…`
//! - `common/…` is the part of `src/common/…` the server uses
//! - `start.rs` is `src/server/start.ts`
//! - `js.rs` holds the JavaScript value semantics both rely on

pub mod common;
pub mod js;
pub mod routes;
pub mod server;
pub mod start;
