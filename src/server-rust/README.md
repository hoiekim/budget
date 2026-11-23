# Rust backend

`budget-server` serves the same HTTP API, against the same PostgreSQL schema,
as the Bun backend in `src/server`. The two live side by side and are held to
the same behavior by one test suite, `conformance/`, which runs unchanged
against either.

```bash
cargo build --release            # target/release/budget-server
bun run build-server-rust        # the same, copied to build/server-rust/
bun run start-server-rust        # serves build/client, like the Bun bundle
cargo test                       # unit tests
bun run test:conformance         # both servers, then a diff of their answers
```

It reads the same environment as the Bun server (`.env.example`), plus
`CLIENT_DIR`: the directory to serve the client from, by default `../client`
beside the directory holding the executable (`build/client` for
`build/server-rust/budget-server`).

## Layout

The crate mirrors the TypeScript module for module, so a change to one side
has an obvious place on the other.

| TypeScript | Rust |
|---|---|
| `src/server/start.ts` | `src/start.rs` |
| `src/server/lib/<name>.ts` | `src/server/<name>.rs` |
| `src/server/lib/postgres/…` | `src/server/postgres/…` |
| `src/server/routes/<group>/<file>.ts` | `src/routes/<group>/<file>.rs` |
| `src/common/…` (the part the server uses) | `src/common/…` |
| JavaScript value semantics | `src/js.rs` |

File and function names are the snake_case of the TypeScript ones.

## Conventions

These exist so the two servers agree on edge cases, not only on the happy
path. A port that reads more idiomatic but answers differently is a bug.

**JSON stays dynamic.** Request bodies, database rows and responses are
`serde_json::Value` (`js::Json`, objects as `js::Obj` in insertion order). A
key that is absent is JavaScript's `undefined`; `Json::Null` is `null`. The
TypeScript distinguishes the two everywhere (a partial update skips
`undefined` and writes `null`), so the port does too. Do not introduce typed
structs for rows or bodies.

**Use `js.rs` wherever JavaScript semantics show.** `js::truthy` for `||`,
`!x` and `if (x)`; a plain null/absent check for `??`. `js::num(f64)` to build
a number (integral values print as `5`, not `5.0`). `js::number_to_string`
for `String(n)` and template literals, never `format!("{}", f64)`, wherever
the text is stored, hashed or compared. `js::to_fixed`, `js::math_round`,
`js::parse_float`, `js::parse_int` for their JavaScript namesakes.
`js::js_length` for `string.length`.

**Dates are `js::JsDate`.** `JsDate::parse` is `new Date(text)` /
`Date.parse`; the `get_*` methods are local time in the process time zone
(`TZ`), `get_utc_*` are UTC; `JsDate::from_local(y, m, d, …)` is
`new Date(y, m, d, …)`. `common::date` has `local_date` (`new LocalDate`),
`get_date_string`, `get_squashed_date_string`, `get_date_time_string`. Never
reach for `chrono` directly in ported logic.

**Database values are the values the TypeScript passes.** `pool().query(sql,
&[json!(…)])` binds JSON values the way the Bun driver does (see the header
of `server/postgres/client.rs`): numbers and booleans go typed, everything
else untyped. Pass a `Date` as its ISO string (`date.to_json()`), an array as
a JSON array, an object as a JSON object. Rows come back as `Obj`:
`NUMERIC`/`BIGINT` as numbers, `DATE` as `YYYY-MM-DD`, `TIMESTAMPTZ` as an ISO
string, json parsed. Keep the SQL text identical to the TypeScript's.

**Tables and repositories.** A table is a `static TABLE: Table`
(`server/postgres/models/<name>.rs`) with the generic statements as methods
(`query`, `query_one`, `insert`, `update`, `upsert`, `upsert_many`,
`soft_delete`, …) taking the same arguments in the same order as
`models/base.ts`; `filters! { "col" => value }` builds a filter list and
`UpdateArgs { user_id: Some(…), ..Default::default() }` carries `update`'s
optional arguments. `Table::query*` validates rows the way the `Model`
constructor does. A repository function returns what the TypeScript one
returns: `to_json(&row)` where it returns `model.toJSON()`.
`with_transaction(|client| Box::pin(async move { … }))` is `withTransaction`.

**Routes.** A handler is `async fn(ctx: &mut Ctx) -> HandlerResult`. Return
`ApiResponse::success()`, `::success_with(body)`, `::failed(message)`; set
`ctx.status` where the TypeScript calls `res.status(n)`; return `Err` where it
throws (the route layer answers 500 and alarms, as `Route.execute` does).
Each route file exports `pub fn routes() -> Vec<Route>` built with
`route!("POST", "/path", handler)` (add `scope = "…"` for a `requiredScope`).
Validation goes through `server/validation.rs`, whose messages match the
TypeScript's character for character. Keep the order of checks: when two
things are wrong with a request, both servers must name the same one.

**Messages and logs are copied verbatim**: response messages, log messages
and their context keys, alarm titles. Tests and operators both read them.

**Outbound HTTP goes through `server::alarm::http_client()`**, one shared
`reqwest` client that honours `HTTPS_PROXY` and the system certificate store.
Send the request the TypeScript sends: same method, URL, query order, headers
and body. The conformance suite records every upstream call and compares the
two servers' calls.

**Fire-and-forget is `tokio::spawn`.** Where the TypeScript starts a promise
and does not await it (`void f()`, `.catch(() => undefined)`), spawn a task;
where it awaits, await.

**No panics on request data.** No `unwrap()`/`expect()`/indexing on anything
derived from a request, the database or an upstream answer.

**Comments say what the code is for**, in the present tense, like the
TypeScript's. Port the reasoning that still applies; drop what only explained
a TypeScript or Bun detail.

## Testing a port

Pure logic gets unit tests beside it (`#[cfg(test)]`), porting the cases of
the TypeScript `*.test.ts` where they apply. Everything reachable over HTTP
is covered by `conformance/` instead: see `conformance/README.md`.

## Where the two servers still differ

Everything the conformance suite exercises answers the same on both servers.
The differences below are known and left in place. Each is either something
Rust's types or libraries cannot express, or a quirk of Bun's runtime rather
than of the TypeScript.

- **Numbers past the double range in a request body** (`1e999`). Bun's
  `JSON.parse` reads them as `Infinity`; `serde_json::Value` cannot hold a
  non-finite number, so Rust treats the whole body as unreadable, as if none
  was sent. Matching it would need a JavaScript value type in place of
  `serde_json::Value`.
- **An unreachable Plaid host.** Bun's axios, sent through an HTTPS proxy,
  never settles, and the request hangs until Bun's idle timeout resets the
  connection. Rust answers 500 and alarms at once.
- **Wording of transport and parse errors** from upstream calls (reqwest
  against axios or `fetch`, JSON parse errors, `TypeError`s for malformed
  answers) is close to Bun's, not identical. It shows in logs and alarm text,
  never in a response body.
- **Plaid webhook signatures** are verified for ES256 (P-256) only, the one
  algorithm Plaid signs with; `jose` would also accept others.
- **Time-zone data.** Rust reads the system tz database, Bun the copy inside
  its ICU. Where the two versions disagree, local times differ too: for
  example Europe/Dublin in 1925, Asia/Tehran in 1979, and Africa/Casablanca's
  predicted changes from 2027.
- **Date text with a vertical tab and non-ASCII Latin-1 characters.**
  JavaScriptCore turns the vertical tab into a space only in strings it keeps
  as 16-bit, which depends on where the string came from; Rust treats such
  text as 8-bit.
- **Unicode tables.** Merchant-name keys fold case and classify letters, and
  the address of an invitation to share data is lower-cased and checked for
  white space, with Rust's Unicode tables, which can disagree with
  JavaScriptCore's for characters added in recent Unicode versions.
- **Concurrent upstream calls.** Where the TypeScript runs calls with
  `Promise.all`, Rust sends them one at a time in Bun's usual order: the
  detail and price lookups of `POST /validate-ticker`, and the Plaid calls
  of an item's sync (`plaid::util::in_call_order`). Bun's own order is fixed
  in the first case and racy in the second, where the tests compare those
  calls as a set (`hub.unordered`). Only latency differs.
- **When one of two concurrent branches fails.** `Promise.all` rejects at
  the first failure and leaves the other branch running in the background;
  Rust waits for both and reports the first failure in branch order. The
  upstream calls and database writes come out the same; the timing of the
  answer and of log lines does not.
- **`undefined` in log context.** Bun's logger prints a context of only
  undefined values as `{}`; Rust has no `undefined` and prints nothing. It
  shows on one webhook log line, for a body without an `item_id`.
