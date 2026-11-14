import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Test preload — runs ONCE before any test file in `bun test`.
 *
 * Two jobs:
 *   1. Register happy-dom as the global DOM. That gives `@testing-library/react`
 *      a document to render React components into, and it makes client-side env
 *      detection (`src/common/utils:environment`) resolve to "unknown" rather
 *      than "server" — without a `window`, `Dictionary.set()` no-ops and the
 *      holdings-calculation tests fail. Registration is process-wide and
 *      reaches well past the DOM — see the note on the `register` call.
 *   2. Capture the REAL exports of leaf modules that tests
 *      commonly mock (the SQL driver, the password wrapper). Tests can then
 *      `afterAll`-restore via these snapshots so a previous test file's
 *      `mock.module("./sql-driver", FakeSQL)` doesn't leak into the next
 *      file's assumptions.
 *
 *      The snapshots are taken at preload time — BEFORE any test file
 *      has a chance to call `mock.module(...)` — so they're guaranteed
 *      to be the real module exports.
 *
 * The `globalThis.__REAL_*` properties are used by tests' afterAll
 * hooks via the `restoreLeaves()` helper in `scripts/test-helpers.ts`.
 *
 * React render helpers built on top of this live in `scripts/test-render.tsx`.
 */

// `register` copies every own property of a happy-dom `GlobalWindow` onto
// `globalThis`, for every test file in the process, server-side ones included.
// It replaces: fetch, Request, Response, Headers, Blob, File, FormData, URL,
// AbortController, AbortSignal, EventTarget, Event, WebSocket, setTimeout,
// setInterval, clearTimeout, clearInterval, queueMicrotask, atob, btoa.
//
// The DOM is what happy-dom is here for; its network stack is not, and that
// stack does not carry the runtime's semantics — happy-dom's
// `new Response(Bun.file(path))` produces the string "[object Blob]" where the
// runtime's produces the file, so a test covering a static-asset route would
// assert 200-and-non-empty while measuring nothing. Put the runtime's own
// network primitives back immediately after registering. `File` travels with
// `Blob` so that `instanceof` still holds between the two.
const NETWORK_GLOBALS = ["fetch", "Request", "Response", "Headers", "Blob", "File", "FormData"] as const;
const nativeNetworkGlobals = NETWORK_GLOBALS.map(
  (name) => [name, (globalThis as Record<string, unknown>)[name]] as const,
);

// Sized to the phone viewport the app is designed against, so a component
// that branches on window dimensions renders its narrow layout here too.
GlobalRegistrator.register({ width: 390, height: 844, url: "http://localhost/" });

for (const [name, value] of nativeNetworkGlobals) {
  (globalThis as Record<string, unknown>)[name] = value;
}

// A test that replaces `globalThis.fetch` does so for every file that runs
// after it, and there is no unmock API. Exposing the real one lets a file that
// needs the network — rather than a stub of it — install it for its own
// duration, the way `__REAL_SQL_DRIVER` lets one opt back out of a leaked
// driver mock.
(globalThis as Record<string, unknown>).__REAL_FETCH = globalThis.fetch;

// Market-data env a test file sets for its own duration. Snapshotted here for
// the same reason `fetch` is: a file that captures its own "original" captures
// whatever the previous file left behind, so one leak survives every restore
// after it. Restoring has to DELETE a name that was unset — assigning
// `undefined` to `process.env` stores the string "undefined", which reads as a
// real API key and sends the suite to the live upstream.
// Named one by one rather than looped: `env-example.test.ts` cannot resolve a
// computed key, and an env access it cannot follow is a hole in that scan.
(globalThis as Record<string, unknown>).__REAL_ENV = {
  POLYGON_API_KEY: process.env.POLYGON_API_KEY,
  POLYGON_RATE_LIMIT_PER_MIN: process.env.POLYGON_RATE_LIMIT_PER_MIN,
  YAHOO_RATE_LIMIT_PER_MIN: process.env.YAHOO_RATE_LIMIT_PER_MIN,
};

// Capture real leaf-dep exports for tests' afterAll restoration. `require`
// runs at statement-order (vs ESM `import` which hoists), so the DOM
// registration above lands first — `common`-side modules consumed by these
// captures will see the stub.
//
// We spread the full namespace (not just a hand-picked subset) so a test
// file that re-mocks a leaf to a partial object can't strand the next
// file's call on a missing export.
const realSqlDriver = require("../src/server/lib/postgres/sql-driver");
const realPassword = require("../src/server/lib/password");

(globalThis as Record<string, unknown>).__REAL_SQL_DRIVER = {
  ...realSqlDriver,
};
(globalThis as Record<string, unknown>).__REAL_PASSWORD = {
  ...realPassword,
};
