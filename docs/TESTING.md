# Testing

## Running Tests

```bash
bun run test           # All tests — always use this, not bare bun test
bun run test:coverage  # Same, with lcov coverage + check-coverage gate
```

`bun run test` invokes `scripts/test-bundled/index.ts`, which discovers
every `*.test.{ts,tsx}` under `src/`, builds a unique per-test bundle for
each one carrying a `// @bundles` annotation, and runs every test file
in a single `bun test` process. Bundled tests load their bundle via
`bundleOf(import.meta.url)`; plain tests import sources directly.

> **Always use `bun run test`, not bare `bun test`.** Bare `bun test`
> skips the orchestrator entirely — it never builds the bundles, never
> sets up `globalThis.__bundlesByTest`, and never stubs `window`. Bundled
> tests fail at `bundleOf` and client tests fail with `Dictionary.set()
> is disabled in server`.

To run a single test file directly:

```bash
# Plain test (no @bundles annotation):
bun test src/path/to/file.test.ts

# Bundled test must go through the orchestrator (it builds the bundle):
bun scripts/test-bundled/index.ts
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

### Bundled tests (call `bundleOf` — source inferred from path)

`bun test` shares one module registry per process, so a raw
`mock.module("pg", …)` would leak across every test file in the run. The
per-test-bundle runner (`scripts/test-bundled/`) avoids this: it builds
a UNIQUE bundle per `(test, source)` pair, with leaf deps (`pg`, `bcrypt`,
…) kept external. Each bundle captures **its own** leaf-dep mocks at
first load and never collides with sibling tests. This replaces the old
practice of plumbing dependency-injection seams through server functions
purely for mockability.

To opt into a bundle, just call `bundleOf<typeof import("./source")>(
import.meta.url)`. The orchestrator detects the call and infers the
source from the test file's path:

- `foo.test.ts` → `foo.ts` in the same dir.
- `Calculations.holdings.test.ts` → drop dotted suffixes until a
  sibling resolves (`Calculations.holdings.ts` → `Calculations.ts`),
  so two test files can target one source.

No annotation needed — calling `bundleOf` IS the declaration.

```typescript
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { bundleOf } from "test-bundled";

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

const { writeUser } = await bundleOf<typeof import("./users")>(import.meta.url);
```

#### Why `bundleOf`, not `await import("./source")`

An earlier framework version registered process-wide
`mock.module(<source-abs>, () => require(<bundle>))` redirects in the
preload so the natural sibling import `await import("./users")` would
land on the bundle. That broke at scale: bun's `mock.module(path,
factory)` is **EAGER** for already-cached paths — when another test had
transitively loaded the source (e.g. via a `server` barrel), the redirect
factory fired IMMEDIATELY, loading the bundle BEFORE the intended test's
`mock.module("pg", FakePool)` ran. The bundle bound real pg, and the
test's mock never took effect.

`bundleOf` sidesteps this by reading the per-test bundle's absolute path
from `globalThis.__bundlesByTest` (populated by the preload) and dynamic-
importing the bundle directly. No `mock.module` redirect, no cascade.

### Mocking sibling source modules (`@external` + `mockExternal`)

To mock a **sibling source module** (not a leaf dep), keep it external
with `// @external <relPath>` and mock it via `mockExternal` from the
`test-bundled` runtime helper:

```typescript
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
shim identities — mocking via the shim doesn't shadow another bundle
or another test's mock of the same source. This is what unblocks mocking
siblings that are themselves other tests' `@bundles` targets (see #451,
#456).

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
