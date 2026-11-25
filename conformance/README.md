# Conformance suite

One set of tests for the app's HTTP API, run unchanged against the Bun backend
(`src/server`) and the Rust backend (`src/server-rust`). The tests drive a
real server process over HTTP against a real PostgreSQL database, with every
outside service (Plaid, SimpleFin, Polygon, Yahoo, BLS, Discord, the identity
provider) replaced by a fake. Neither server has test-only code: each is
started the way production starts it.

```bash
bun run test:conformance                 # both servers, then compare their answers
bun run test:conformance:bun             # the Bun server only
bun run test:conformance:rust            # the Rust server only (builds it first)
bun conformance/run.ts tests/login.test.ts --tz America/Los_Angeles
cd conformance && CONFORMANCE_TARGET=rust bun test --timeout 30000 tests/login.test.ts   # one file, directly
```

It needs a PostgreSQL the run may create databases in (default
`postgres:postgres@127.0.0.1:5432`; override with `CONFORMANCE_PG_HOST`,
`_PORT`, `_USER`, `_PASSWORD`), with `max_connections` of a few hundred since
each started server keeps a pool of 20, and the `openssl` command.
`CONFORMANCE_VERBOSE=1` echoes each server's log.

`compare-databases.ts` compares what two databases hold, table by table, for
checking the servers against each other on copies of real data (see "Running
it in production" in `src/server-rust/README.md`).

## How it works

- **`harness/stack.ts`** — `startStack(options)` makes an empty database,
  starts the fakes, and starts the server named by `CONFORMANCE_TARGET`
  (`bun` or `rust`) on a free port. It returns a `Stack`: clients
  (`stack.anonymous()`, `stack.login()`), the database (`stack.db`), the fakes
  (`stack.upstream`), the server's log (`stack.logs`, `stack.waitForLog`), and
  `stack.restart()`. A file starts one stack in `beforeAll` and stops it in
  `afterAll`; a file that needs other settings (single sign-on on, production
  mode, no Polygon key) starts its own with `env`.
- **`harness/upstreams/hub.ts`** — the servers call their upstreams at fixed
  `https://` hosts. Each is started with `HTTPS_PROXY` pointing at a local
  proxy that hands every connection to one TLS server holding a throwaway
  certificate the servers are told to trust (`harness/certs.ts`). Fakes
  register handlers per host with `hub.on(host, handler)`; the newest handler
  is asked first and may pass. Every call is logged in `hub.requests`.
- **`harness/client.ts`** — an HTTP client that keeps cookies like a browser
  tab and never follows redirects. Paths are under `/api` unless written with
  a leading `//`.
- **`harness/postgres.ts`** — `stack.db.query/one/insert/rows` on the
  server's own database: seed what no endpoint creates, assert what a request
  stored.
- **`harness/transcript.ts` and `compare.ts`** — every exchange, and every
  upstream call, is recorded per target. After both targets ran, `compare.ts`
  diffs the two transcripts with generated values (ids, timestamps, tokens)
  masked. The test code being identical, any difference is a difference
  between the servers, including in fields no assertion looked at.

## Writing tests

A test file covers one group of endpoints, **every branch of each**: read the
route and the repository functions it calls, and write a case for every
`return`, every thrown error, and every condition that changes what is stored
or answered. In particular:

- every validation message, with each wrong type, `null`, absent, empty, out
  of bounds, and the boundary value itself;
- every kind of data the endpoint handles (each account type, transaction
  shape, snapshot type, provider, nullable column set and unset);
- ownership: another user's row, a row that does not exist, a soft-deleted row;
- anonymous access (401) and, where it applies, API-key access;
- the stored result, read back through `stack.db`, not only the response;
- what the server asked its upstreams, through `stack.upstream.<fake>.seen()`.

Rules that keep the suite the same on both servers and on any machine:

- Assert whole response bodies with `toEqual`, building the expected value
  from what the test created. Match generated values by shape
  (`expect.stringMatching`, `expect.any(String)`).
- Do not assume a time zone or today's date. The run sets `TZ` for the
  servers and the test process alike; compute dates from `new Date()` with
  local-time methods, as the servers do.
- Give requests that touch a rate limit their own address
  (`headers: { "X-Real-IP": "10.x.y.z" }`); limits are per address and live
  for the server process.
- Do not write down the test process's own address. Where the host has IPv6
  the servers see `::ffff:127.0.0.1`, where it has not `127.0.0.1`; ask
  `loopbackAddress()`.
- Mark an exchange whose answer is inherently different per run with
  `noCompare: true` so the transcript diff skips it; say why in a comment.
- Wrap a request whose upstream calls the Bun server starts at once, and
  which reach the upstream in no fixed order there, in
  `stack.upstream.hub.unordered(() => …)`: the diff then compares the calls
  that arrived meanwhile as a set, per host. Use it only where the Bun
  server's own order is racy, and say why in a comment.
- Wait for background effects with `stack.waitFor(() => …)` or
  `stack.waitForLog(…)`, never with a fixed sleep.
- Write the test against the Bun server first: it is the reference. Then run
  it against Rust, then run both through `conformance/run.ts` and bring the
  transcript diff to zero.

## Pinned Bun behaviours

The Bun server is the reference, so where it does something that looks like
a bug, the suite pins what it does and the Rust server copies it. Each test
that pins one says so in a comment above it. Fixing one means changing both
servers and that test together.

| Behaviour | Pinned in |
|---|---|
| `GET /recurrings` with a `start-date` the database cannot read answers 500 and alarms, instead of a validation message | `recurrings.test.ts` |
| `POST /recurrings` with a `recurring_id`, and `DELETE /recurrings` with an `id`, that is not a UUID answer 500 and alarm | `recurrings.test.ts` |
| Pairing a suggested pair again with `status: "confirmed"` leaves it suggested | `transfers.test.ts` |
| A transaction can be paired with itself | `transfers.test.ts` |
| Transfer detection counts a suggestion it does not store when a deleted pair holds the same transactions, and a stranger's pair for them makes its insert fail ("Failed to insert transfer pair") | `detect-transfers.test.ts` |
| A plan-statement row whose id someone else's row holds is counted as written but not stored | `plan-statement.test.ts` |
| A plan-statement answer naming deleted rows still sends all three change events, though nothing was written | `plan-statement-effects.test.ts` |
| One failed price backfill after a plan-statement import stops the pricing of every later security | `plan-statement-effects.test.ts` |
| A Plaid `ITEM_LOGIN_REQUIRED` during sync marks the item bad, yet records the sync as a success | `sync-plaid.test.ts` |
| The `PENDING_EXPIRATION` webhook marks an item bad whatever its provider | `plaid-webhook.test.ts` |
| The `ITEM_UPDATED` webhook on a SimpleFin item asks Plaid's `/item/get` with the SimpleFin URL as access token, and answers 500 | `plaid-webhook.test.ts` |
| A pending SimpleFin transaction is stored as posted | `sync-simple-fin.test.ts` |
| An invitation to an address the demo account has is sent, though one to its username is refused; the demo account sees and can decline it, and only accepting is refused | `sharing-email.test.ts` |

One more is worked around rather than pinned: each SimpleFin sync gives every
holding's security a new random id; tests read the id back instead of naming
it.
