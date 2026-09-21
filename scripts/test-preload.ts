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
 *   2. Capture the REAL exports of leaf node-modules that tests
 *      commonly mock (`pg`, `bcrypt`). Tests can then `afterAll`-restore
 *      via these snapshots so a previous test file's
 *      `mock.module("pg", FakePool)` doesn't leak into the next file's
 *      assumptions.
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
// duration, the way `__REAL_PG` lets one opt back out of a leaked `pg` mock.
(globalThis as Record<string, unknown>).__REAL_FETCH = globalThis.fetch;

// Capture real leaf-dep exports for tests' afterAll restoration. `require`
// runs at statement-order (vs ESM `import` which hoists), so the DOM
// registration above lands first — `common`-side modules consumed by these
// captures will see the stub.
//
// We spread the full namespace (not just a hand-picked subset) because
// these libs' methods reference each other through `module.exports` at
// runtime — e.g. `bcrypt.hash` internally calls `module.exports.genSalt`.
// If `restoreLeaves` then re-mocks bcrypt to a partial object, the
// missing-internal-reference crashes the next test file's bcrypt call.
const realPg = require("pg");
const realBcrypt = require("bcrypt");

(globalThis as Record<string, unknown>).__REAL_PG = {
  ...realPg,
  default: realPg.default ?? realPg,
};
(globalThis as Record<string, unknown>).__REAL_BCRYPT = {
  ...realBcrypt,
  default: realBcrypt.default ?? realBcrypt,
};
