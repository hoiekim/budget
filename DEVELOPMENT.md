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

### Adding Database Tables

1. Add model in `src/server/lib/postgres/models/`
2. Add repository in `src/server/lib/postgres/repositories/`
3. Add migration SQL (manual for now - see issue #62)
