# Design Patterns

## Entity ID Preservation During Sync

When cloning or transforming entities for sync operations, **preserve references to original IDs before any mutation**. Cloning and then looking up data by the clone's ID will fail if the clone gets a new ID.

```typescript
// Bad — cloned capacity gets new ID, lookup returns wrong data
const cloned = structuredClone(budget);
delete cloned.capacity_id;
const data = capacityData.get(cloned.getActiveCapacity().id); // always misses

// Good — capture original reference before cloning
const originalCapacity = budget.getActiveCapacity();
const cloned = structuredClone(budget);
const data = capacityData.get(originalCapacity.id); // correct lookup
```

When a function both transforms entities and looks up related data, capture all necessary references from the originals first.

## Defensive Capacity Array Access

**Always guard against empty `capacities` arrays before calling `getActiveCapacity()`.**

Budget, Section, and Category entities store scheduled amounts in a `capacities` array. A newly-created or partially-migrated entity may have an empty array.

`getActiveCapacity()` on `BudgetFamily` returns a default `new Capacity()` (zero amount, no date) when the array is empty. Display logic should handle zero-amount budgets gracefully (e.g., placeholder UI rather than blank cards).

## Balance Calculation: 3-Tier Price Fallback

Investment account balances use a prioritized price resolution strategy:

1. **Institution price** — brokerage-reported price (most authoritative)
2. **Security snapshot** — market data from Polygon API
3. **Inferred price** — calculated from `institution_value / quantity`

Always use `getAccountBalance(account)` instead of accessing `account.balances.current` directly — it handles investment accounts correctly using this fallback chain.

See `src/client/lib/hooks/calculation/holdings.ts` for the `getPriceForHolding` implementation.

## Scheduled Task Concurrency

Long-running scheduled tasks (e.g., sync) must guard against overlapping execution. Use `setInterval + unref()` for the recurring timer:

```typescript
let syncTimer: ReturnType<typeof setInterval> | null = null;
let isSyncing = false;

const runSync = async () => {
  if (isSyncing) {
    logger.warn("Skipping scheduled sync — previous still running");
    return;
  }
  isSyncing = true;
  try {
    // ... sync logic ...
  } finally {
    isSyncing = false;
  }
};

export const scheduledSync = () => {
  runSync();
  syncTimer = setInterval(runSync, ONE_HOUR);
  syncTimer.unref(); // don't prevent clean process exit
};

export const stopScheduledSync = () => {
  if (syncTimer !== null) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
};
```

- Separate `runSync` (logic) from `scheduledSync` (timer setup) so tests can call `runSync` directly
- Always call `.unref()` on module-level timers
- Export a `stop*` function and call it in `start.ts` shutdown handler

## Process Lifecycle Handlers

Process-level handlers (`SIGINT`, `SIGTERM`, `unhandledRejection`, `uncaughtException`) belong in the application entry point (`start.ts`), not in library modules. Shutdown should drain resources in order:

1. Stop accepting new connections (close HTTP server)
2. Close database pool
3. Exit process

```typescript
const gracefulShutdown = async () => {
  server.close();
  await pool.end();
  process.exit(0);
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
```

Library modules should not register global process handlers as side effects of import.

## Collection Lookup Performance

When matching items across two collections, **pre-build lookup structures** instead of nested iteration:

```typescript
// Bad — O(n²)
storedTransactions.forEach((t) => {
  const found = incoming.find((f) => f.id === t.id);
  if (!found) removed.push(t);
});

// Good — O(n)
const incomingIds = new Set(incoming.map((t) => t.id));
storedTransactions.forEach((t) => {
  if (!incomingIds.has(t.id)) removed.push(t);
});
```

This matters in sync operations where transaction lists can grow to thousands of entries.
