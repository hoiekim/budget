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

A labeled transaction stores its category across three correlated columns. Both the `transactions` table and the `split_transactions` table carry all three (`label_category_id`, `label_budget_id`, `label_category_confidence`).

| Column | Type | On `transactions` | On `split_transactions` |
|---|---|---|---|
| `label_category_id` | UUID, nullable | ✓ | ✓ |
| `label_budget_id` | UUID, nullable | ✓ | ✓ |
| `label_category_confidence` | FLOAT, nullable | ✓ | ✓ (added by #344) |

**Write both `label_category_id` and `label_budget_id` together.** The UI category `<select>` filters options by the row's budget. Writing only `label_category_id` leaves the dropdown unable to render the value. See `defaultApplyLabel` in `src/server/lib/compute-tools/auto-suggest.ts` for the canonical pattern.

**The states of `label_category_confidence`:** the `0 < c < 1` band is split into two reserved buckets so suggestion provenance is recoverable.

| Value | Meaning |
|---|---|
| `NULL` | Row is unlabeled (`label_category_id IS NULL`) |
| `0` | User rejected an auto-suggestion |
| `c < 0.99` (engine cap `0.98`) | Auto-suggest engine applied a label, not yet confirmed by user |
| `0.99` | `/api/suggest-category` write (external Claude instance) |
| `1` | User confirmed |

**Prod backfill.** A backfill on 2026-05-13 set `label_category_confidence = 1` for every row with `label_category_id IS NOT NULL`. The application code's confirmation predicate (`category_confidence === 1 && !!category_id` in `src/client/lib/hooks/calculation/budgets.ts`) does not tolerate `NULL`, so this backfill is load-bearing — any new INSERT that sets `label_category_id` without also setting `label_category_confidence` would reintroduce the "labeled but counted as unsorted" miscount.

**Split transactions.** Splits inherit the same four-state encoding as transactions. `SplitTransaction.toTransaction()` rebuilds the label using the split's own `category_confidence`, so a user-confirmed split (`1`) lands in the sorted bucket and an auto-suggested split (`0 < c < 1`) lands in unsorted. The two-pass auto-suggest engine (#344) writes per-split suggestions; the `POST /split-transaction` route applies `inferLabelConfidence` so FE-driven updates write `1` on user-set categories and `0` on user-cleared categories.

See [ARCHITECTURE.md — Transaction Categorization](ARCHITECTURE.md#transaction-categorization-auto-suggest) for the full data-model view and [DESIGN_PATTERNS.md — Auto-Suggest Merchant Signal Scoring](DESIGN_PATTERNS.md#auto-suggest-merchant-signal-scoring) for the suggestion engine itself.
