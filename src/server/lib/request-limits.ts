/**
 * Ceiling on an inbound request body. `Bun.serve` enforces it at the transport:
 * an over-limit body is answered 413 before the `fetch` handler runs, so the
 * server never reads, buffers or parses one — which matters most for
 * unauthenticated callers, whose body would otherwise be materialized well
 * before the auth gate rejects them.
 *
 * The largest legitimate payload is `POST /suggest-category`'s batch, which the
 * route caps at 500 entries — under 100 KB on the wire.
 */
export const MAX_REQUEST_BODY_SIZE = 1024 * 1024;
