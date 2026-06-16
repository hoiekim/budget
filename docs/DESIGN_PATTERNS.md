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

## Balance Calculation: Holding Price Resolution

Investment account balances pick between two recorded prices and fall back to inference only when neither is usable:

1. **Institution price** — brokerage-reported price on the holding snapshot itself
2. **Security snapshot** — market data from Polygon (or any source written to `security_snapshots`)
3. **Inferred price** — `institution_value / quantity`, used only when neither source above has a usable price

When both an institution price and a security snapshot exist, whichever was **recorded later wins**, with the security snapshot winning on a tie (so a fresh Polygon refresh between Plaid syncs supersedes a stale `institution_price`, and manual accounts — which never carry `institution_price` — always use the security snapshot). The security side never consumes a future snapshot: at view-date `YYYY-MM`, the most recent entry whose `yearMonth` is on or before `YYYY-MM` is used.

Always use `getAccountBalance(account)` instead of accessing `account.balances.current` directly — it handles investment accounts correctly using this resolution.

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

## Auto-Suggest Merchant Signal Scoring

Auto-categorization (`src/server/lib/compute-tools/auto-suggest.ts`) writes category suggestions onto unlabeled transactions by scoring each target against the user's already-labeled history across **seven weighted features**, not a single merchant match. For every unlabeled target the engine runs one feature-signal query, picks the winning category, and applies a suggestion only if three gates pass.

**Per-row feature score.** A historical confirmed row scores against the target as the weighted sum of the features it matches:

| Feature                              | Weight | Match rule                                              |
| ------------------------------------ | ------ | ------------------------------------------------------- |
| `merchant_name`                      | 100    | pg_trgm `similarity >= TEXT_SIMILARITY_THRESHOLD` (0.5) |
| `name`                               | 50     | pg_trgm `similarity >= 0.5`                             |
| `plaid_pfc_primary`                  | 10     | Plaid `personal_finance_category.primary` equal         |
| amount band                          | 5      | target amount within ±`AMOUNT_BAND_TOLERANCE` (20%), sign-preserving |
| `payment_channel`                    | 1      | equal                                                   |
| `account_id`                         | 1      | equal                                                   |
| day-of-month band                    | 1      | within ±`DAY_BAND_TOLERANCE` (3 days)                   |

The large merchant/name weights mean one identity-feature match (merchant alone = 100) outweighs the entire weak-feature trio (amount + channel + day = 7) by design, so category volume never drowns out feature quality. Only rows whose per-row score clears `ROW_SCORE_THRESHOLD` (15) contribute — that floor filters out coincidental weak-only matches. `SUM(score)` per category picks the winner.

**Three gates** (all in `evaluateSignal`, applied to the winning category):

| Gate         | Threshold                                              | Reason                                                       |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------ |
| Sample size  | `count_matched >= 3`                                   | At least 3 historical rows cleared the per-row threshold     |
| Reject rate  | `rejected / (accepted + rejected) <= 0.10`             | `rejected` is the symmetric weighted sum over `rejected_categories ⋈ transactions`; users actively disagree → back off |
| Quality      | `accepted / (count_matched × max_per_row) >= MIN_QUALITY` (0.30) | Average per-row match strength, independent of how many rows matched |

`max_per_row` is the sum of the weights for the features the target actually has populated (a null `merchant_name` excludes its 100-weight from the denominator), keeping the quality metric in `[0, 1]`.

**Stored confidence is the quality value itself**, clamped to `[ENGINE_CONFIDENCE_FLOOR, ENGINE_CONFIDENCE_CEIL] = [0.5, 0.98]` — variable, so downstream UX can render "weakly confident" vs "strongly confident" without re-deriving. The ceiling is deliberately strict about the confidence-bucket reservations:

| `label_category_confidence` | Source                                  |
| --------------------------- | --------------------------------------- |
| `[0.5, 0.98]`               | auto-suggest engine (hard clamp)        |
| `(0, 1)` exclusive          | `/api/suggest-category` (external API)  |
| `1.0`                       | user-confirmed label                    |

Two of these three boundaries are enforced: the engine hard-clamps to `[0.5, 0.98]`, and `1.0` is rejected by the API validator (`o.confidence > 0 && o.confidence < 1`, `post-suggest-category.ts`) and reserved for the cookie-session UI write path. The `0.99` band the engine ceiling stays below (`auto-suggest.ts` `ENGINE_CONFIDENCE_CEIL`, "below the `0.99` contract band") is a *convention* the engine observes for external callers — the API route itself accepts any value in `(0, 1)`, which overlaps the engine band. So a row's provenance is recoverable from confidence alone only for the two enforced buckets; an external `(0, 1)` write is not distinguishable from an engine write by value.

**One query per target, not per merchant.** A run iterates over top-level transactions then split transactions (splits inherit all features from their parent via JOIN — see `fetchUnlabeledSplits`, closes #334). There is **no** per-merchant signal cache: the signal depends on the target's full feature set, so two unlabeled transactions sharing a merchant but differing in amount / channel get different signals, and a per-merchant cache would produce wrong predictions. The unlabeled pool is bounded by a 7-day window in `fetchUnlabeled`.

**Apply-with-budget.** When the engine applies a suggestion it writes both `label_category_id` and `label_budget_id`. The UI's category `<select>` filters options by the row's budget, so a category whose parent budget isn't recorded would render as a blank placeholder even though the yellow dot indicates a suggestion is present. See `applyLabel`.

**Compare-and-swap on apply.** Both apply sites thread `CAS_NULL_CONFIDENCE` (`label_category_confidence IS NULL`) into the UPDATE so the engine only overwrites a row that is *still* unlabeled. Between the unlabeled fetch and the per-row apply a user may have confirmed the row in the UI (writing `confidence = 1`); the guard prevents the engine from clobbering that confirmation.

**What never receives a suggestion.** `fetchUnlabeled` filters on `label_category_confidence: null`, so any row that already carries a confidence — user-confirmed (`1.0`), an external API write (any value in `(0, 1)`), or a prior engine suggestion — is skipped regardless of the value.

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
