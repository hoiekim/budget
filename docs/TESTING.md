# Testing

## Running Tests

```bash
bun run test           # All tests
bun run test:coverage  # Same, with lcov coverage + check-coverage gate
bun test src/path/to/file.test.ts   # Single file (preload is wired via bunfig.toml)
```

Native `bun:test`. `bunfig.toml` registers `scripts/test-preload.ts`, which
runs once before any test file and:

1. Registers happy-dom as the global DOM at a 390×844 viewport — the phone
   viewport the app is designed against — so client-side env detection
   resolves to "unknown" instead of "server" (without a `window`,
   `Dictionary.set()` no-ops and client-side calc tests fail) and
   components have a document to render into. It then restores the
   runtime's native network globals (`fetch`, `Request`, `Response`, …):
   happy-dom's network stack does not carry the runtime's semantics, so a
   test covering a static-asset route would assert against happy-dom's
   `[object Blob]` instead of the real file.
2. Captures the REAL exports of the SQL driver, the password wrapper,
   `fetch`, and the market-data env on `globalThis.__REAL_*` so
   `restoreLeaves()` can re-mock leaf deps back to a known baseline
   between test files.

## Writing Tests

```typescript
import { describe, it, expect } from "bun:test";

describe("featureName", () => {
  it("does something", () => {
    expect(actual).toBe(expected);
  });
});
```

### Mocking the SQL driver / password wrapper (the per-file isolation pattern)

`bun:test`'s `mock.module(...)` is **process-global** — once any test file
mocks the SQL driver with a FakeSQL, every subsequent file in the run sees
that mock. To keep the pool per-file, two things conspire:

1. `src/server/lib/postgres/client.ts` constructs its `SQL` client lazily,
   on first use, and the `SQL` reference is a live ESM binding to
   `./sql-driver`'s export — so when a test mocks the driver, the first
   pool use instantiates the test's FakeSQL. Production code imports `SQL`
   only through `./sql-driver` because `mock.module(...)` cannot override
   the `"bun"` builtin itself.
2. `scripts/test-helpers.ts#restoreLeaves` re-mocks the driver and the password wrapper
   back to the preload snapshots and calls `resetPool()` to drop the cached
   instance, so the NEXT file's first pool use rebuilds against its own
   mock.

```typescript
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { createFakeSql, restoreLeaves } from "test-helpers";

const { driver, mockUnsafe, mockReservedUnsafe } = createFakeSql();
mock.module("./sql-driver", () => driver);

// Dynamic-import AFTER the mock so the source resolves the driver → FakeSQL.
const { writeUser } = await import("./users");

afterAll(restoreLeaves);
```

`createFakeSql` scripts executor-level `{ rows, rowCount }` results; its
`unsafe` translates those to the Bun-shaped arrays the production adapter
converts, so the adapter's row mapping runs for real. Pool-level statements
are asserted against `mockUnsafe`, reserved-connection statements against
`mockReservedUnsafe`.

The pool and the reserved connection are *separate* mocks on purpose:
`withTransaction` reaches the database through `reserve()`, so if the
reserved client handed back the pool's `unsafe`, both would share one call
log and no assertion could tell where a statement ran. Dropping the `client`
argument from a cascade would then leave the suite green while, in
production, that cascade commits on its own and survives the caller's
rollback. Assert an in-transaction statement against `mockReservedUnsafe`
— and its absence from `mockUnsafe`.

`resetSqlMocks` (not a bare `mockReset`) is the way to clear those mocks
between tests: bun's `mockReset` drops the implementation, so an `unsafe()`
that resolves to `undefined` blows up inside `withTransaction` long before
the assertion it was meant to reach. `resetSqlMocks` re-installs the
implementation after resetting; `clearSqlMocks` only clears the call logs
and keeps it.

### Mocking sibling source modules (the snapshot-and-restore pattern)

Two pitfalls when mocking a sibling source module:

1. **Process-global leak.** The mock outlives the file unless explicitly
   restored.
2. **Barrel re-export partial-module crash.** When a test mocks a leaf
   module with only the function under test, any barrel that re-exports
   `*` from it now resolves to a partial namespace. Sibling tests that
   transitively import through the barrel crash with
   `Export named '<other-fn>' not found in module`.

Fix both by snapshotting the real namespace first, spreading it into the
mock factory, and re-mocking back to the snapshot in `afterAll`:

```typescript
import * as realApiKeys from "./postgres/repositories/api_keys";
const realApiKeysSnap = { ...realApiKeys };

mock.module("./postgres/repositories/api_keys", () => ({
  ...realApiKeysSnap,
  verifyApiKey: mockVerifyApiKey,
}));

const { resolveBearerAuth } = await import("./bearer-auth");

afterAll(() => {
  mock.module("./postgres/repositories/api_keys", () => realApiKeysSnap);
  restoreLeaves();
});
```

The `import *` is a real ESM static import — when the file's `mock.module`
runs at module-eval time, the static import has already resolved, so the
namespace snapshot is real.

### Rendering client components

Page components read everything they need from `AppContext`, so rendering
one in isolation means supplying a real `ContextType`.
`scripts/test-render.tsx` is the harness for that — it is what the
`*.test.tsx` files under `src/client/` use:

- `buildContext(overrides?)` assembles a real context out of the real
  models (`new Data()`, `new Calculations()`, a pinned `ViewDate`), so a
  test exercises production code paths rather than a parallel fake.
- `renderWithContext(ui, context)` renders under a `Context.Provider`; the
  returned `rerenderWithContext` re-wraps with a fresh context, which is
  how a test reproduces the re-render a data sync causes in the running app.
- `buildRouter(path, params?)` is a recording `ClientRouter` — navigation a
  page asked for, in call order, instead of performed.
- `stubFetch(routes)` replaces `globalThis.fetch` for one test and throws
  on an unstubbed path, so a page can never reach the real network;
  `client/lib/call` runs for real on top of it. Run its `restore` from
  `afterEach`, not from the end of the test body, or an assertion that
  throws mid-test leaves every later file talking to this stub.

Every render test needs this `afterEach`:

```typescript
import { cleanup } from "@testing-library/react";
import { renderWithContext, resetDom } from "test-render";

afterEach(() => {
  cleanup();
  resetDom();
});
```

`cleanup()` alone is not enough: happy-dom registers one `localStorage`
and one `sessionStorage` for the whole process, and `cleanup()` leaves
both standing — a key a page's mount effect writes (the router's `"path"`,
a cached order) is still there for whichever file bun runs next.

## Test Requirements

**Always write unit tests for new code files and lines.** This is a
project rule, not a suggestion.

- New files: create a corresponding `*.test.ts` file
- New functions: add cases covering expected behavior and edge cases
- Bug fixes: add a regression test that would have caught the bug

Write additional tests for existing uncovered lines when feasible.

## Test Location

Tests are co-located with source files:

```
src/server/lib/validation.ts
src/server/lib/validation.test.ts
src/server/lib/postgres/repositories/users.ts
src/server/lib/postgres/repositories/users.test.ts
```
