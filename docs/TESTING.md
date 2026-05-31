# Testing

## Running Tests

```bash
bun run test               # All tests — always use this, not bare bun test
bun run test:bundled       # Per-test-bundle suite only (isolated module mocks)
bun run test:non-bundled   # Everything else (client + server, shared registry)
bun run test:coverage      # Bundled suite + non-bundled coverage report
```

`bun run test` runs `test:bundled` followed by `test:non-bundled`.

> **Always use `bun run test`, not bare `bun test`.** Bare `bun test` skips the
> bundled suite entirely and runs without the `src/client/test-setup.ts`
> preload, so client tests fail with `Dictionary.set() is disabled in server`
> for holdings-calculation tests. `test:non-bundled` supplies that preload.

To run a single non-bundled test file, pass the same preload:

```bash
bun test --preload ./src/client/test-setup.ts src/path/file.test.ts
```

Bundled tests can't be run with bare `bun test` — they are discovered, built,
and run by the orchestrator. Run the whole bundled suite with `bun run
test:bundled` (it builds in parallel, ~1.5s).

## Writing Tests

```typescript
import { describe, it, expect } from "bun:test";

describe("featureName", () => {
  it("should do something", () => {
    expect(actual).toBe(expected);
  });
});
```

### Bundled tests (`*.test.bundle.ts`)

`bun test` shares one module registry per process, so `mock.module()` calls leak
across files. The per-test-bundle runner (`scripts/test-bundled/`) works around
this: it bundles each source-under-test into a unique file with leaf deps (`pg`,
`bcrypt`, …) kept external, so each test captures **its own** mocks at first load
and never collides with sibling tests in the same `bun test` process. This
replaces the old practice of plumbing dependency-injection seams through server
functions purely for mockability.

Use a bundled test when the unit mocks a leaf dependency (typically `pg`). Name
it `*.test.bundle.ts`, co-located with the source, and annotate it:

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

The `// @bundles` source is imported by its **natural sibling path**
(`await import("./users")`); the runner's preload registers a redirect from that
source path to the built bundle, so the leaf-dep mocks above are captured at
first load.

To also mock a **sibling source module** (not a leaf dep), keep it external with
`// @external <relPath>` and mock it at the same relative path:

```typescript
// @bundles src/server/lib/postgres/repositories/snapshots.ts
// @external ./securities
mock.module("./securities", () => ({ searchSecuritiesById: mockSearchSecuritiesById }));
```

> `// @external` works for a sibling that isn't itself another test's
> `// @bundles` target. The runner reserves each `@bundles` source path for that
> one bundle's redirect, so two bundled tests can't both mock the same source
> module (see issue #451).

See the existing `*.test.bundle.ts` files for full examples.

## Test Requirements

**Always write unit tests for new code files and lines.** This is a project rule, not a suggestion.

- New files: create a corresponding `*.test.ts` file
- New functions: add test cases covering expected behavior and edge cases
- Bug fixes: add regression tests that would have caught the bug

Write additional tests for existing uncovered lines when feasible.

## Test Location

Tests are co-located with source files:

```
src/server/lib/validation.ts
src/server/lib/validation.test.ts          # standard, shared-registry test
src/server/lib/postgres/repositories/users.test.bundle.ts   # isolated bundle test
```
