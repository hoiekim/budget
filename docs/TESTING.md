# Testing

## Running Tests

```bash
bun run test           # All tests
bun run test:coverage  # Same, with lcov coverage + check-coverage gate
bun test src/path/to/file.test.ts   # Single file (preload is wired via bunfig.toml)
```

Native `bun:test`. `bunfig.toml` registers `scripts/test-preload.ts`, which
runs once before any test file and:

1. Stubs `globalThis.window = {}` so client-side env detection resolves to
   "unknown" instead of "server" — without it, `Dictionary.set()` no-ops and
   client-side calc tests fail.
2. Captures the REAL exports of the SQL driver and the password wrapper on
   `globalThis.__REAL_*` so `restoreLeaves()` can re-mock leaf deps back
   to a known baseline between test files.

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
