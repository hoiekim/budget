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

## Properties UI: row / keyValue / button Pattern

All "settings page" sections (account details, transaction details, configuration, API keys, etc.) render inside a container with class `Properties`, and follow a consistent row pattern. The global rules in `App/index.css` are scoped on `.Properties > .property` and `.Properties > .propertyLabel` direct children — break the structure and the styles silently drop. `TransactionProperties/index.tsx` is the canonical reference.

### Structure

```jsx
<div className="MyComponent Properties">
  <div className="propertyLabel">Section&nbsp;Name</div>
  <div className="property">
    {/* every direct child of .property is a .row */}
    <div className="row keyValue">
      <span className="propertyName">Read-only key</span>
      <span>read-only value</span>
    </div>
    <div className="row keyValue">
      <span className="propertyName">Editable key</span>
      <input type="text" /> {/* or a <select>, or a wrapper <div> with one inside */}
    </div>
    <div className="row button">
      <button onClick={onAction}>Action</button>
    </div>
  </div>
</div>
```

### Rules

- The outer container (or its ancestor) must include `Properties` so the direct-child selectors apply.
- A child component that participates in the section returns a fragment (`<>…</>`) so its `propertyLabel` and `property` divs become direct children of the parent's `.Properties` container — wrapping them in another `<div>` breaks the styling.
- Every direct child of `.property` is a `.row` of some kind. Don't use `<ul>`/`<li>`, raw flex containers, or grid layouts — model lists as multiple `.property` blocks (one per item) or stacked rows.
- For each row:
  - **`.row.keyValue`** for label/value rows. Left side is a `<span className="propertyName">` (the section's gray-on-dark label color comes from the global rule `.row.keyValue span.propertyName`). Right side is either a `<span>` (read-only display), or an editable form control (`<input>`, `<select>`, or a wrapper `<div>` containing one).
  - **`.row.button`** for action button rows. Exactly one `<button>` per row. The global rule `.row > button` already applies `width: 100%`, hover state, and transparent background — don't restyle.
- For destructive actions, use `<button className="delete colored">…</button>`. The `delete` class color comes from the global rule.
- For empty / loading / error placeholder rows, use a plain `<div className="row">` with a `<span className="propertyName disabled">…</span>` (single-cell row, grey).

### What to avoid

- Custom flex / grid layouts inside `.property` (the row class already handles spacing, dividers, and padding).
- Custom borders on Cancel/secondary buttons (the global button styles are intentionally borderless).
- Wrapping `propertyLabel` / `property` in another container — the `.Properties > X` direct-child selectors will stop matching.

When in doubt, open `src/client/components/TransactionProperties/index.tsx` and copy the structure.

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
