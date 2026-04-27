# Testing

## Running Tests

```bash
bun run test               # All tests — always use this, not bare bun test
bun run test:client        # Client-only (React components, hooks, common)
bun run test:server        # Server-only (routes, repositories, utilities)
bun test --watch           # Watch mode
bun run test:coverage      # With coverage report
```

> **Always use `bun run test`, not bare `bun test`.** Client tests require a preload file (`src/client/test-setup.ts`) to initialize browser globals. Bare `bun test` mixes client and server contexts and causes `Dictionary.set() is disabled in server` failures for holdings calculation tests.

To run a single server-side test file:

```bash
bun test src/path/file.test.ts
```

Client tests need the preload flag, so use `bun run test:client` for those.

## Writing Tests

```typescript
import { describe, it, expect } from "bun:test";

describe("featureName", () => {
  it("should do something", () => {
    expect(actual).toBe(expected);
  });
});
```

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
src/server/lib/validation.test.ts
```
