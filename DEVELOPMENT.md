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

### Authentication

All API routes require an authenticated session by default. Authentication is enforced by centralized middleware in `start.ts` — individual routes do **not** need to check `req.session.user`.

Public routes (login, webhooks, health) are explicitly allowlisted:

```typescript
const PUBLIC_PATHS = ["/login", "/plaid-hook", "/health"];
```

When adding a new public endpoint, add its path to `PUBLIC_PATHS`. All other routes automatically return 401 if no session exists.

### Security Headers

Security response headers are set globally in `start.ts` middleware:

- **Content-Security-Policy** — restricts script/style/image sources to `'self'`
- **X-Content-Type-Options: nosniff** — prevents MIME type sniffing
- **X-Frame-Options: DENY** — prevents clickjacking
- **X-XSS-Protection** — legacy XSS filter (defense-in-depth)
- **Referrer-Policy: strict-origin-when-cross-origin**

When adding new frontend features that load external resources (fonts, images, scripts), update the CSP directives in `start.ts` rather than disabling CSP.

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

### Authentication Security

**Prevent timing-based username enumeration.** Always run the password comparison even when the user is not found, using a pre-computed dummy hash:

```typescript
const DUMMY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
const pwMatches = user
  ? await bcrypt.compare(password, user.password)
  : await bcrypt.compare(password, DUMMY_HASH).then(() => false);
```

Without the dummy comparison, `bcrypt.compare` (~100ms) only runs when the user exists, letting attackers measure response times to enumerate valid usernames.

Also return the same generic error message regardless of failure reason:

```typescript
// ✅ Good - Same message for both cases
return { status: "failed", message: "Invalid username or password." };

// ❌ Bad - Reveals whether username exists
return { status: "failed", message: "User is not found." };
return { status: "failed", message: "Wrong password." };
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
- Unit tests (`bun run test`)

### Deployment

Merges to `main` trigger:
1. Docker image build (Dockerfile builder stage runs `bun run typecheck`, `bun run test`, and `bun run build` — build fails if any of these fail)
2. Push to Docker Hub
3. Deployment webhook

**Note on `NODE_ENV`:** Bun bakes `NODE_ENV` at build time into the output bundle. Setting `NODE_ENV` via `docker run -e` at runtime will have no effect on server behavior — configure environment-dependent behavior through other env vars (e.g., `APP_TIMEZONE`, `POSTGRES_HOST`).

## Security Patterns

### Centralized Authentication Middleware

Authentication is enforced at the router level in `src/server/start.ts`, not per-route. All API endpoints require an authenticated session by default.

```typescript
const PUBLIC_PATHS = ["/login", "/plaid-hook", "/health"];
router.use((req, res, next) => {
  if (PUBLIC_PATHS.some((p) => req.path === p || req.path.startsWith(p + "/"))) {
    return next();
  }
  if (!req.session.user) {
    res.status(401).json({ status: "failed", message: "Not authenticated." });
    return;
  }
  next();
});
```

**Rules:**
- **New routes are protected automatically** — no need to add auth checks per route
- **To make a route public**, add its path to `PUBLIC_PATHS` with justification
- **Per-route `req.session.user` checks** remain as defense-in-depth but are not the primary gate
- **Public routes must have external verification** (e.g., `/plaid-hook` verifies Plaid signatures)

### Session Fixation Prevention

On successful login, the session ID is regenerated to prevent session fixation attacks:

```typescript
await new Promise<void>((resolve, reject) => {
  req.session.regenerate((err) => {
    if (err) reject(err);
    else resolve();
  });
});
req.session.user = maskedUser;
```

This ensures that a pre-authentication session ID cannot be reused after login.

### Input Validation

Use the validation helpers from `src/server/lib/validation.ts`:

```typescript
import { requireBodyObject, requireStringField, validationError } from "server";

const bodyResult = requireBodyObject(req);
if (!bodyResult.success) return validationError(bodyResult.error!);

const idResult = requireStringField(body, "account_id");
if (!idResult.success) return validationError(idResult.error!);
```

**Rules:**
- Always validate `req.body` is an object before accessing fields
- Use `requireStringField` / `requireQueryString` for required parameters
- Return structured validation errors, not raw error messages

## Design Patterns

### Entity ID Preservation During Sync

When cloning or transforming entities for sync operations, **preserve references to original IDs** before any mutation. Cloning an object and then looking up data by the clone's ID will fail if the clone gets a new ID.

```typescript
// ❌ Bad — cloned capacity gets new ID, lookup returns wrong data
const cloned = structuredClone(budget);
delete cloned.capacity_id; // new UUID generated
const data = capacityData.get(cloned.getActiveCapacity().id); // always misses

// ✅ Good — capture original reference before cloning
const originalCapacity = budget.getActiveCapacity();
const cloned = structuredClone(budget);
const data = capacityData.get(originalCapacity.id); // correct lookup
```

This pattern was critical in PR #134 where budget sync zeroed out all amounts because cloned capacities had new UUIDs.

**Rule:** When a function both transforms entities and looks up related data, capture all necessary references from the originals first.

### Defensive Capacity Array Access

**Always guard against empty `capacities` arrays before calling `getActiveCapacity()`.** Budget, Section, and Category entities store scheduled amounts in a `capacities` array. A newly-created or partially-migrated entity may have an empty array, which causes `getActiveCapacity()` to crash without a guard.

```typescript
// ❌ Bad — crashes if capacities is empty
const capacity = budget.getActiveCapacity(date);
const amount = capacity.month;

// ✅ Good — getActiveCapacity() returns a default Capacity() when array is empty
// This is guaranteed by the guard added in PR #139:
getActiveCapacity = (date: Date) => {
  if (!this.capacities.length) return new Capacity(); // guard
  const sorted = this.sortCapacities("desc");
  // ...
};
```

The `getActiveCapacity()` method on `BudgetFamily` (`src/client/lib/models/BudgetFamily.ts`) returns a default `new Capacity()` (zero amount, no date) when the array is empty. Callers should expect this and handle a zero amount gracefully rather than treating it as an error.

**Rule:** Never assume `capacities` is non-empty. The guard in `getActiveCapacity()` protects against crashes, but display logic should still handle zero-amount budgets visually (e.g., placeholder UI rather than blank cards).

### Authentication: Anti-Enumeration

Login endpoints must not reveal whether a username exists:

- **Generic error messages:** Always return "Invalid username or password" regardless of which is wrong
- **Constant-time comparison:** When a user is not found, perform a dummy `bcrypt.compare` against a valid hash to prevent timing attacks

```typescript
// ❌ Bad — reveals valid usernames
if (!user) return res.json({ message: "User is not found" });
if (!match) return res.json({ message: "Wrong password" });

// ✅ Good — constant-time, generic message
if (!user) {
  await bcrypt.compare(password, DUMMY_HASH); // prevent timing leak
  return res.json({ message: "Invalid username or password" });
}
```

See `src/server/routes/users/post-login.ts` for the implementation (PR #136).

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

### Scheduled Task Concurrency

Long-running scheduled tasks (e.g., sync) must guard against overlapping execution:

```typescript
let isSyncing = false;

export const scheduledSync = async () => {
  if (isSyncing) {
    logger.warn('Skipping scheduled sync — previous still running');
    setTimeout(scheduledSync, ONE_HOUR);
    return;
  }
  isSyncing = true;
  try {
    // ... sync logic ...
  } finally {
    isSyncing = false;
    setTimeout(scheduledSync, ONE_HOUR);
  }
};
```

Without this guard, slow API responses or network timeouts can cause concurrent syncs that race on the same data.

### Process Lifecycle Handlers

Process-level handlers (`SIGINT`, `SIGTERM`, `unhandledRejection`, `uncaughtException`) belong in the application entry point (`start.ts`), not in library modules. Shutdown should drain resources in order:

1. Stop accepting new connections (close HTTP server)
2. Close database pool
3. Exit process

```typescript
// start.ts — NOT in postgres/client.ts
const server = app.listen(port, ...);

const gracefulShutdown = async () => {
  server.close();
  await pool.end();
  process.exit(0);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
```

Library modules should not register global process handlers as side effects of import.

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

### Resource Ownership Verification

**Every delete/update route must verify the resource belongs to the authenticated user.**

Repository-level `softDelete` by primary key alone is NOT sufficient — it doesn't scope by `user_id`:

```typescript
// ❌ Dangerous - deletes any user's resource
await snapshotsTable.softDelete(snapshot_id);

// ✅ Safe - verify ownership first
const snapshot = await searchSnapshots(user, { snapshot_id });
if (!snapshot) return { status: "failed", message: "Not found" };
await snapshotsTable.softDelete(snapshot_id);

// ✅ Better - scope the delete query itself by user_id
await pool.query(
  "UPDATE snapshots SET is_deleted = TRUE WHERE snapshot_id = $1 AND user_id = $2",
  [snapshot_id, user.user_id]
);
```

Routes like `deleteAccounts` correctly use `searchAccountsById(user, ...)` to verify ownership before deleting. All delete/update routes should follow this pattern.

### Collection Lookup Performance

When matching items across two collections (e.g., finding removed transactions), **pre-build lookup structures** instead of nested iteration:

```typescript
// ❌ O(n²) - .find() inside .forEach()
storedTransactions.forEach((t) => {
  const found = incoming.find((f) => f.id === t.id);
  if (!found) removed.push(t);
});

// ✅ O(n) - Set lookup
const incomingIds = new Set(incoming.map((t) => t.id));
storedTransactions.forEach((t) => {
  if (!incomingIds.has(t.id)) removed.push(t);
});
```

This matters in sync operations where transaction lists can grow to thousands of entries.

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
