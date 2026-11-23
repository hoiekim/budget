//! `src/server/lib/request-limits.ts`.

/// Ceiling on an inbound request body. An over-limit body is answered 413
/// before any handler runs, so the server never buffers or parses one.
pub const MAX_REQUEST_BODY_SIZE: usize = 1024 * 1024;
