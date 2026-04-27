# Database

## Connection

Configure via environment variables:

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_HOST` | — | PostgreSQL server address |
| `POSTGRES_PORT` | 5432 | PostgreSQL port |
| `POSTGRES_USER` | — | PostgreSQL user |
| `POSTGRES_PASSWORD` | — | PostgreSQL password |
| `POSTGRES_DB` | — | PostgreSQL database name |

## Table Class Methods

**Use `Table` class methods instead of direct SQL/pool operations.**

The `Table` base class (`src/server/lib/postgres/models/base.ts`) provides type-safe methods for common operations:

```typescript
// Good — use Table class methods
const user = await UsersTable.findById(userId);
const users = await UsersTable.findByCondition("email", email);
await UsersTable.insert(userData);
await UsersTable.update(userId, updates);
await UsersTable.deleteById(userId);

// Avoid — direct pool.query
const result = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
```

Use direct SQL for: complex joins or aggregations, performance-critical bulk operations, one-off migrations.

## Repository Pattern

Database operations live in `src/server/lib/postgres/repositories/`:

```typescript
import { pgGetUsers, pgUpsertUser } from "server";
```

## Transaction Atomicity

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
