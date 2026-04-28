# Database

## Connection

Configure via environment variables:

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_HOST` | — | PostgreSQL server address |
| `POSTGRES_PORT` | 5432 | PostgreSQL port |
| `POSTGRES_USER` | — | PostgreSQL user |
| `POSTGRES_PASSWORD` | — | PostgreSQL password |
| `POSTGRES_DATABASE` | `budget` | PostgreSQL database name |

## Table Class Methods

**Use `Table` class methods instead of direct SQL/pool operations.**

The `Table` base class (`src/server/lib/postgres/models/base.ts`) provides type-safe methods for common operations. Each table is exported as a `camelCase` singleton (e.g. `usersTable`, `accountsTable`):

```typescript
// Good — use Table class methods
const users = await usersTable.query({ user_id: userId });
const oneUser = await usersTable.queryOne({ username });
const someByIds = await usersTable.queryByIds([id1, id2]);
await usersTable.insert(row);
await usersTable.update(userId, updates);
await usersTable.upsert(row);
await usersTable.softDelete(userId);
await usersTable.hardDelete(userId);

// Avoid — direct pool.query
const result = await pool.query("SELECT * FROM users WHERE user_id = $1", [userId]);
```

Use direct SQL for: complex joins or aggregations, performance-critical bulk operations, one-off migrations.

## Repository Pattern

Higher-level helpers live in `src/server/lib/postgres/repositories/` and wrap the table singletons (e.g. `searchUser`, `writeUser`, `updateUser`, `getUserById`, `deleteUser`). Import them from the `server` alias:

```typescript
import { searchUser, writeUser } from "server";
```

## Transaction Atomicity

Multi-step database operations must be wrapped in transactions. Prefer the `withTransaction` helper from `src/server/lib/postgres/client.ts` — it handles `BEGIN` / `COMMIT` / `ROLLBACK` / `release` automatically:

```typescript
import { withTransaction } from "server";

await withTransaction(async (client) => {
  await accountsTable.update(account_id, { balance }, undefined, user.user_id, client);
  await snapshotsTable.insert({ account_id, balance }, undefined, client);
});
```

Most `Table` methods accept an optional `client?: QueryExecutor` so the same statement can run inside or outside a transaction.

See `deleteAccounts` in `src/server/lib/postgres/repositories/accounts.ts` for a real example.
