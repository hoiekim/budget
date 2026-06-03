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
2. Captures the REAL exports of `pg` and `bcrypt` on `globalThis.__REAL_*`
   so `restoreLeaves()` can re-mock leaf deps back to a known baseline
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

### Mocking `pg` / `bcrypt` (the per-file isolation pattern)

`bun:test`'s `mock.module(...)` is **process-global** — once any test file
mocks `"pg"` with a FakePool, every subsequent file in the run sees that
mock. To keep the pool per-file, two things conspire:

1. `src/server/lib/postgres/client.ts` exports a **lazy Proxy** Pool. The
   actual `new Pool(config)` is deferred to first property access, and the
   `Pool` reference is a live ESM binding to `pg.Pool` — so when a test
   mocks `pg`, the proxy's first-access instantiates the test's FakePool.
2. `scripts/test-helpers.ts#restoreLeaves` re-mocks `pg` and `bcrypt` back
   to the preload snapshots and calls `resetPool()` to drop the cached
   instance, so the NEXT file's first pool use rebuilds against its own
   mock.

```typescript
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

const mockQuery = mock(async () => ({ rows: [], rowCount: 0 }));
class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
}
mock.module("pg", () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {} },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
}));

// Dynamic-import AFTER the mock so the source resolves pg → FakePool.
const { writeUser } = await import("./users");

afterAll(restoreLeaves);
```

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
