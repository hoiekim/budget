# Testing

## Running Tests

```bash
bun run test           # All tests — always use this, not bare bun test
bun run test:coverage  # Same, with lcov coverage + check-coverage gate
```

`bun run test` invokes `scripts/test-bundled/index.ts`, which discovers every
`*.test.{ts,tsx}` under `src/`, partitions them by whether they carry a
`// @bundles` annotation, and runs each group in its own `bun test` process.
Bundled tests get the per-bundle isolation preload (source→bundle redirects,
real-barrel snapshots, `__externalsByTest` map); plain tests just get a
`globalThis.window = {}` stub for client-side env detection.

> **Always use `bun run test`, not bare `bun test`.** Bare `bun test` skips
> the orchestrator entirely — it never builds the bundles, so bundled tests
> hit raw `mock.module(<source>, …)` collisions, and it never sets the
> `window` stub, so client tests fail with
> `Dictionary.set() is disabled in server`.

To run a single test file directly:

```bash
# Plain test (no @bundles annotation):
bun test src/path/to/file.test.ts

# Bundled test: must go through the orchestrator (it builds the bundle):
bun scripts/test-bundled/index.ts
# (then either pass the file via env arg in a future enhancement, or run
#  the whole suite — bundle build is ~400ms so this is cheap.)
```

## Writing Tests

```typescript
import { describe, it, expect } from "bun:test";

describe("featureName", () => {
  it("should do something", () => {
    expect(actual).toBe(expected);
  });
});
```

### Bundled tests (`// @bundles` annotation)

`bun test` shares one module registry per process, so a raw
`mock.module("pg", …)` would leak across every test file in the run. The
per-test-bundle runner (`scripts/test-bundled/`) avoids this: it bundles
each source-under-test into a unique file with leaf deps (`pg`, `bcrypt`,
…) kept external, so each bundle captures **its own** mocks at first
load and never collides with sibling tests. This replaces the old
practice of plumbing dependency-injection seams through server functions
purely for mockability.

Add the `// @bundles` annotation to the top of the test file (any
`*.test.ts` under `src/` is auto-discovered):

```typescript
// @bundles src/server/lib/postgres/repositories/users.ts
import { describe, test, expect, mock, beforeEach } from "bun:test";

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

// Natural sibling import — the runner's preload redirects it to the bundle.
const { writeUser } = await import("./users");
```

The runner registers a redirect from the annotated source's abs path to
the built bundle, so the leaf-dep mocks above are captured at first load.

### Mocking sibling source modules (`@external` + `mockExternal`)

To mock a **sibling source module** (not a leaf dep), keep it external
with `// @external <relPath>` and mock it via `mockExternal` from the
`test-bundled` runtime helper:

```typescript
// @bundles src/server/lib/bearer-auth.ts
// @external ./postgres/repositories/api_keys
// @external ./postgres/repositories/users
import { mockExternal } from "test-bundled";

mockExternal(import.meta.url, "./postgres/repositories/api_keys", () => ({
  verifyApiKey: mockVerifyApiKey,
}));
mockExternal(import.meta.url, "./postgres/repositories/users", () => ({
  getMaskedUserById: mockGetMaskedUserById,
}));
```

`mockExternal` resolves to a per-test SHIM path under
`.test-bundles/__shims__/`. The shim's default content is `export * from
"<real-abs-source>"`, so a non-mocked external falls through to the real
module. Two tests `@external`-ing the same source land on DIFFERENT
shim identities — mocking via the shim doesn't shadow another bundle's
redirect or another test's mock. This is what unblocks mocking siblings
that are themselves other tests' `@bundles` targets (see #451, #456).

## Test Requirements

**Always write unit tests for new code files and lines.** This is a
project rule, not a suggestion.

- New files: create a corresponding `*.test.ts` file
- New functions: add test cases covering expected behavior and edge cases
- Bug fixes: add regression tests that would have caught the bug

Write additional tests for existing uncovered lines when feasible.

## Test Location

Tests are co-located with source files:

```
src/server/lib/validation.ts
src/server/lib/validation.test.ts                            # plain
src/server/lib/postgres/repositories/users.ts
src/server/lib/postgres/repositories/users.test.ts           # bundled (has @bundles)
```

The same `.test.ts` suffix is used for both — the `@bundles` annotation
at the top of the file is the only marker the runner needs.
