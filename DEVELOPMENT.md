# Development Guide

## Quick Start

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run development server
bun run dev

# Build for production
bun run build

# Start production server
bun run start
```

## Project Structure

```
src/
├── client/           # React frontend
│   ├── components/   # React components
│   ├── lib/          # Client utilities, hooks, models
│   └── index.tsx     # Entry point
├── server/           # Express backend
│   ├── routes/       # API route handlers
│   ├── lib/          # Server utilities
│   │   ├── postgres/ # Database repositories and models
│   │   ├── plaid/    # Plaid API integration
│   │   └── simple-fin/ # SimpleFin integration
│   └── start.ts      # Server entry point
└── common/           # Shared code (client + server)
    ├── models/       # Data models
    └── utils/        # Utility functions
```

## API Patterns

### Route Definition

Routes use a custom `Route` class:

```typescript
import { Route } from "server";

export const myRoute = new Route<ResponseType>("POST", "/path", async (req, res, stream) => {
  // Return an ApiResponse
  return { status: "success", body: data };
});
```

### Response Format

All API responses follow this structure:

```typescript
interface ApiResponse<T> {
  status: "loading" | "streaming" | "success" | "failed" | "error";
  body?: T;
  message?: string;
}
```

- `success`: Request completed successfully
- `failed`: Business logic failure (e.g., wrong password)
- `error`: Server error (500)

### Input Validation

Use validation helpers from `server/lib/validation.ts`:

```typescript
const bodyResult = requireBodyObject(req);
if (!bodyResult.success) return validationError(bodyResult.error!);

const fieldResult = requireStringField(body, "fieldName");
if (!fieldResult.success) return validationError(fieldResult.error!);
```

## Testing

### Test Requirements (Mandatory)

**Always write unit tests for new code files and lines.** This is a project rule, not a suggestion.

- New files: Create a corresponding `*.test.ts` file
- New functions: Add test cases covering expected behavior and edge cases
- Bug fixes: Add regression tests that would have caught the bug

Write additional tests for existing uncovered lines when feasible. Check coverage with `bun test --coverage`.

### Running Tests

```bash
bun test                    # Run all tests
bun test --watch           # Watch mode
bun test src/path/file.test.ts  # Single file
```

### Test Location

- Unit tests: Adjacent to source files (`*.test.ts`)
- Test coverage: Run `bun test --coverage`

### Writing Tests

```typescript
import { describe, it, expect } from "bun:test";

describe("featureName", () => {
  it("should do something", () => {
    expect(actual).toBe(expected);
  });
});
```

### Test Requirements

**Always write unit tests for new code files.** When adding a new utility, helper, or module:
- Create `<filename>.test.ts` alongside the source file
- Test the public interface and edge cases
- PRs adding new code without tests will require justification

## Code Style

### Module Imports

**Always import from the highest module alias** (`common`, `server`, or `client`). Do not use relative import paths.

```typescript
// ✅ Good - Import from module aliases
import { Account, useAppContext, GraphInput } from "client";
import { LocalDate, ViewDate } from "common";
import { pgGetUsers } from "server";

// ❌ Bad - Relative imports
import { Account } from "../../models/Account";
import { useAppContext } from "../context";
import { GraphInput } from "../../../components/Graph/lib/graph";
```

**Benefits:**
- Consistent import style across the codebase
- Easier refactoring (moving files doesn't break imports)
- Clear module boundaries

### TypeScript

- Avoid `any` - use proper types or `unknown` with type guards
- Use explicit return types for exported functions
- Prefer interfaces over type aliases for objects

### Error Handling

Server routes catch errors and return 500:

```typescript
try {
  // route logic
} catch (error: any) {
  console.error(error);
  res.status(500).json({ status: "error", info: error?.message });
}
```

### Structured Logging

**Use the logger module instead of `console.*` methods.**

```typescript
import { logger } from "server/lib/logger";

// Info-level logging with context
logger.info("Sync completed", { userId: user.id, itemCount: 42 });

// Warning with context
logger.warn("Rate limit approaching", { endpoint: "/api/sync", remaining: 5 });

// Error logging (automatically captures stack traces)
logger.error("Sync failed", { userId: user.id }, error);

// Debug logging (only shown when LOG_LEVEL=debug)
logger.debug("Processing item", { itemId, data });
```

**Environment behavior:**
- **Production:** JSON output for log aggregators
- **Development:** Human-readable colored output
- **Test:** Silent by default (set `LOG_LEVEL=debug` to enable)

**Log levels:** `debug` < `info` < `warn` < `error`

Set minimum level with `LOG_LEVEL` environment variable.

### Async Error Propagation

**Don't swallow errors with `.catch(console.error)`.** This pattern silently hides failures:

```typescript
// ❌ Bad - Error is logged but not propagated
await doSomething().catch(console.error);
// Calling code thinks this succeeded

// ✅ Good - Log and re-throw
await doSomething().catch((error) => {
  console.error("Operation failed:", error);
  throw error;  // Propagate to caller
});

// ✅ Good - Let caller handle it
await doSomething();  // Throws naturally
```

This is especially important in scheduled tasks where failures need to be tracked.

### Time Constants

Use named constants from `common/utils/date.ts`:

```typescript
import { ONE_HOUR, TWO_WEEKS, THIRTY_DAYS } from "common";
```

## Database

### PostgreSQL Connection

Connection configured via environment variables:
- `POSTGRES_HOST`
- `POSTGRES_PORT` (default: 5432)
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_DB`

### Table Class Methods (Convention)

**Use Table class methods instead of direct SQL/pool operations.**

The `Table` base class (`src/server/lib/postgres/models/base.ts`) provides type-safe methods for common operations:

```typescript
// ✅ Good - Use Table class methods
const user = await UsersTable.findById(userId);
const users = await UsersTable.findByCondition("email", email);
await UsersTable.insert(userData);
await UsersTable.update(userId, updates);
await UsersTable.deleteById(userId);

// ❌ Avoid - Direct pool.query
const result = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
```

**Benefits:**
- Type safety for column names and values
- Consistent error handling
- Automatic parameter sanitization
- Easier to test and mock

**When to use direct SQL:**
- Complex joins or aggregations not supported by Table methods
- Performance-critical bulk operations
- One-off migrations

### Repository Pattern

Database operations are in `src/server/lib/postgres/repositories/`:

```typescript
import { pgGetUsers, pgUpsertUser } from "server";
```

### Models

Data models are in `src/server/lib/postgres/models/` with base class providing common operations.

## CI/CD

### Pull Request Checks

- TypeScript type checking (`bun run typecheck`)
- ESLint linting (`bun run lint`)
- Unit tests (`bun test`)

### Deployment

Merges to `main` trigger:
1. Docker image build
2. Push to Docker Hub
3. Deployment webhook

## Design Patterns

### Balance Calculation: 3-Tier Price Fallback

Investment account balances use a prioritized price resolution strategy:

1. **Institution price** — brokerage-reported price (most authoritative)
2. **Security snapshot** — market data from Polygon API
3. **Inferred price** — calculated from `institution_value / quantity`

See `src/client/lib/hooks/calculation/holdings.ts` for the `getPriceForHolding` implementation.

Always use `getAccountBalance(account)` instead of accessing `account.balances.current` directly — it handles investment accounts correctly using this fallback chain.

### Transaction Atomicity

Multi-step database operations must be wrapped in transactions:

```typescript
const client = await pool.connect();
try {
  await client.query("BEGIN");
  // ... multiple operations ...
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}
```

See `deleteAccounts` in `src/server/lib/postgres/repositories/accounts.ts` for an example.

### External API Graceful Degradation

When calling external APIs (Plaid, Polygon), handle unavailability gracefully:

- **Service not configured:** Return 503 with a clear message (e.g., "Plaid integration is not configured")
- **API failure:** Log the error, return partial results or fallback values — don't crash the request
- **Rate limiting:** Implement backoff, notify user if sync is delayed

See `src/server/lib/polygon.ts` for the Polygon API graceful degradation pattern.

### Typed Result Pattern for External APIs

Use discriminated unions for external API results instead of throwing:

```typescript
type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: "no_api_key" | "api_error" | "no_data"; message: string };
```

This forces callers to handle all failure modes explicitly. See `PolygonResult<T>` in `src/server/lib/polygon.ts`.

**Always validate HTTP responses** before parsing:
```typescript
const response = await fetch(url);
if (!response.ok) {
  return { success: false, error: "api_error", message: `HTTP ${response.status}` };
}
const data = await response.json();
```

### SimpleFin Integration

SimpleFin provides financial data through the [SimpleFin Bridge Protocol](https://www.simplefin.org/protocol.html):

1. **Setup token** → base64-decoded URL → POST exchange → access URL
2. **Access URL** → embedded credentials → Basic auth for data fetching
3. **Data translation** → SimpleFin types are mapped to internal Plaid-compatible types

Key files:
- `src/server/lib/simple-fin/tokens.ts` — token exchange and URL decoding
- `src/server/lib/simple-fin/data.ts` — data fetching
- `src/server/lib/simple-fin/translators.ts` — type mapping to internal models
- `src/server/lib/compute-tools/sync-simple-fin.ts` — sync orchestration

The translator layer maps SimpleFin account types to Plaid `AccountType` enums, preserving compatibility with the rest of the codebase.

## Accessibility

### Interactive Elements

**Use semantic HTML for interactive elements.** Non-interactive elements with `onClick` are not keyboard-accessible or screen-reader-friendly.

```tsx
// ❌ Bad - div is not keyboard-accessible
<div className="AccountRow" onClick={onClickAccount}>

// ✅ Good - button is focusable and announces as interactive
<button className="AccountRow" onClick={onClickAccount}>

// ✅ Acceptable - when button styling is impractical
<div role="button" tabIndex={0} onClick={onClickAccount}
  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClickAccount(); }}>
```

### Form Inputs

**Every `<input>` must have an associated label:**

```tsx
// ✅ Good - explicit label
<label htmlFor="budget-name">Budget Name</label>
<input id="budget-name" value={name} onChange={onChange} />

// ✅ Good - aria-label when visual label exists nearby
<input aria-label="Budget capacity amount" value={amount} onChange={onChange} />
```

## Timer Cleanup in React

**Every `setTimeout`/`setInterval` in a `useEffect` must be cleaned up on unmount.**

```tsx
// ❌ Bad - timer fires after unmount
useEffect(() => {
  const id = setTimeout(() => setSomething(true), 500);
}, [dep]);

// ✅ Good - cleanup prevents stale updates
useEffect(() => {
  const id = setTimeout(() => setSomething(true), 500);
  return () => clearTimeout(id);
}, [dep]);
```

For recursive polling patterns (e.g., waiting for a ref to be available), use a cancellation flag:

```tsx
useEffect(() => {
  let cancelled = false;
  const poll = () => {
    if (cancelled) return;
    if (!ref.current) { setTimeout(poll, 100); return; }
    // ... use ref
  };
  const id = setTimeout(poll, 100);
  return () => { cancelled = true; clearTimeout(id); };
}, [deps]);
```

## Common Tasks

### Adding a New API Route

1. Create route file in `src/server/routes/<domain>/`
2. Export route instance
3. Add to `src/server/routes/<domain>/index.ts`
4. Define response type with `export type`

### Adding a New Component

1. Create folder in `src/client/components/`
2. Add `index.tsx` and optional `index.css`
3. Export from `src/client/components/index.ts`

### Adding Database Tables/Columns

Schema migrations run automatically on server startup. The migration system compares TypeScript model definitions with the actual database schema and adds missing columns.

1. Add model in `src/server/lib/postgres/models/`
2. Add repository in `src/server/lib/postgres/repositories/`
3. Define the schema in your model class (schema is compared against database)
4. Server startup will automatically add any missing columns

**What's automatic:**
- Adding new columns to existing tables
- Detecting type mismatches (logged as warnings)

**What's NOT automatic (requires manual migration):**
- Dropping columns (safety precaution)
- Renaming columns
- Changing column types
- Creating new tables (add to `initialize.ts`)

See `src/server/lib/postgres/migration.ts` for implementation details.
