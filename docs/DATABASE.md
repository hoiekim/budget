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

## Transaction Categorization Columns

A labeled transaction stores its category across three correlated columns. Both the `transactions` table and the `split_transactions` table carry `label_category_id` and `label_budget_id`; only `transactions` carries `label_category_confidence`.

| Column | Type | On `transactions` | On `split_transactions` |
|---|---|---|---|
| `label_category_id` | UUID, nullable | ✓ | ✓ |
| `label_budget_id` | UUID, nullable | ✓ | ✓ |
| `label_category_confidence` | NUMERIC(3,2), nullable | ✓ | — (column does not exist) |

**Write both `label_category_id` and `label_budget_id` together.** The UI category `<select>` filters options by the row's budget. Writing only `label_category_id` leaves the dropdown unable to render the value. See `defaultApplyLabel` in `src/server/lib/compute-tools/auto-suggest.ts` for the canonical pattern.

**The four states of `label_category_confidence`:**

| Value | Meaning |
|---|---|
| `NULL` | Never evaluated by auto-suggest. Includes legacy pre-Phase-2 user labels written before the column existed |
| `0` | User rejected an auto-suggestion |
| `0 < c < 1` | Auto-suggested, not yet confirmed by user |
| `1` | User confirmed |

**Backfill consideration.** Rows with `label_category_id IS NOT NULL AND label_category_confidence IS NULL` exist in prod from pre-Phase-2 labeling. Application code treats `(category_id set, confidence = NULL)` as confirmed (see `isLabelConfirmed` in `src/client/lib/hooks/calculation/budgets.ts`), so a backfill migration is not strictly required for correctness — but it would let auto-suggest mine those rows as positive signal. Split transactions are always treated as confirmed when `label_category_id` is set (the column doesn't exist there).

See [ARCHITECTURE.md — Transaction Categorization](ARCHITECTURE.md#transaction-categorization-auto-suggest) for the full data-model view and [DESIGN_PATTERNS.md — Auto-Suggest Merchant Signal Scoring](DESIGN_PATTERNS.md#auto-suggest-merchant-signal-scoring) for the suggestion engine itself.
