# Migration Plan: Schema Refinement (Pre-Release)

Three changes to finalize before release:
1. **Soft delete everywhere** — remove ON DELETE CASCADE, convert hard deletes
2. **Hybrid columns + raw JSONB** — reduce column count, store full provider objects
3. **Capacities table** — extract from JSONB into separate table with UUID PKs

---

## Guiding Principles

- **Never touch client-side code** except model type definitions (`src/common/models/`)
- **Preserve API response structure** — same JSON shapes returned to the client
- **Use TypeScript compiler** to verify type compatibility after changes
- **Server-side only refactor** — changes in `src/server/lib/postgres/`, `src/server/routes/`, migration tool

---

## Change #1: Soft Delete Everywhere

### 1.1 Remove ON DELETE CASCADE

**File:** `src/server/lib/postgres/initialize.ts`

Change all `ON DELETE CASCADE` to `ON DELETE RESTRICT`:

| Table | FK Column | References | Current | New |
|-------|-----------|------------|---------|-----|
| items | user_id | users(user_id) | CASCADE | RESTRICT |
| accounts | user_id | users(user_id) | CASCADE | RESTRICT |
| holdings | user_id | users(user_id) | CASCADE | RESTRICT |
| transactions | user_id | users(user_id) | CASCADE | RESTRICT |
| investment_transactions | user_id | users(user_id) | CASCADE | RESTRICT |
| split_transactions | user_id | users(user_id) | CASCADE | RESTRICT |
| budgets | user_id | users(user_id) | CASCADE | RESTRICT |
| sections | user_id | users(user_id) | CASCADE | RESTRICT |
| sections | budget_id | budgets(budget_id) | CASCADE | RESTRICT |
| categories | user_id | users(user_id) | CASCADE | RESTRICT |
| categories | section_id | sections(section_id) | CASCADE | RESTRICT |
| charts | user_id | users(user_id) | CASCADE | RESTRICT |

### 1.2 Convert Hard Deletes to Soft Deletes

**Snapshots** — add `is_deleted BOOLEAN DEFAULT FALSE` column to snapshots table, then convert:

| Function | File | Current | New |
|----------|------|---------|-----|
| `deleteOldSnapshots` | snapshots.ts | `DELETE FROM snapshots WHERE snapshot_date < $1` | `UPDATE snapshots SET is_deleted = TRUE WHERE snapshot_date < $1` |
| `deleteSnapshotsByAccount` | snapshots.ts | `DELETE FROM snapshots WHERE account_id = $1 AND user_id = $2` | `UPDATE snapshots SET is_deleted = TRUE WHERE account_id = $1 AND user_id = $2` |
| `deleteSnapshotsByUser` | snapshots.ts | `DELETE FROM snapshots WHERE user_id = $1` | `UPDATE snapshots SET is_deleted = TRUE WHERE user_id = $1` |
| `deleteSnapshotById` | snapshots.ts | `DELETE FROM snapshots WHERE snapshot_id = $1 AND user_id = $2` | `UPDATE snapshots SET is_deleted = TRUE WHERE snapshot_id = $1 AND user_id = $2` |

**Users** — convert hard delete:

| Function | File | Current | New |
|----------|------|---------|-----|
| `deleteUser` | users.ts | `DELETE FROM users WHERE user_id = $1` | `UPDATE users SET is_deleted = TRUE WHERE user_id = $1` |

**Sessions** — keep hard delete (sessions are ephemeral, not business data):

| Function | File | Action |
|----------|------|--------|
| `destroy` | session.ts | Keep as `DELETE FROM sessions` (no change) |

### 1.3 Add is_deleted filter to snapshot queries

All snapshot SELECT queries need `AND (is_deleted IS NULL OR is_deleted = FALSE)` added to their WHERE clauses. Audit all functions in `snapshots.ts` that do SELECT.

### Checklist — Change #1
- [ ] Add `is_deleted BOOLEAN DEFAULT FALSE` to snapshots table in initialize.ts
- [ ] Change all `ON DELETE CASCADE` → `ON DELETE RESTRICT` in initialize.ts
- [ ] Convert `deleteUser` to soft delete in users.ts
- [ ] Convert 4 snapshot delete functions to soft delete in snapshots.ts
- [ ] Add `is_deleted` filter to all snapshot SELECT queries in snapshots.ts
- [ ] Run `npx tsc --noEmit` — verify no type errors
- [ ] Test: deleting a budget should NOT cascade-delete sections/categories (RESTRICT blocks it)
- [ ] Decide: should deleting a budget also soft-delete its children? If yes, add explicit soft-delete cascade logic in `deleteBudget` (soft-delete sections → categories too)

---

## Change #2: Hybrid Columns + Raw JSONB

### Strategy

For each table that stores provider data:
1. Keep columns used in **WHERE, JOIN, INDEX, or aggregation**
2. Keep columns that are **user-edited** (not from provider)
3. Add one `raw JSONB` column storing the **full provider object**
4. Remove all other flattened columns

On sync (write): store full provider object in `raw`, extract indexed fields to columns
On user edit: update only user-edited columns (don't touch `raw`)
On read: reconstruct response from `raw` + user-edited columns

### 2.1 Transactions Table

**Current: 39 columns → New: 13 columns + 1 JSONB = 14 (saves 25)**

Keep as columns:
```
transaction_id VARCHAR(255) PRIMARY KEY    -- PK, queried
user_id UUID                               -- FK, queried
account_id VARCHAR(255)                    -- queried, indexed
name TEXT                                  -- used in sync matching
amount DECIMAL(15, 2)                      -- used in sync matching
date DATE                                  -- queried, indexed
pending BOOLEAN                            -- queried, indexed
label_budget_id UUID                       -- user-edited
label_category_id UUID                     -- user-edited
label_memo TEXT                            -- user-edited
raw JSONB                                  -- full provider object
updated TIMESTAMP
is_deleted BOOLEAN
```

Remove (moved into `raw`):
- `pending_transaction_id`, `category_id`, `category`
- `location_*` (8 columns)
- `payment_meta_*` (8 columns)
- `account_owner`, `iso_currency_code`, `unofficial_currency_code`
- `payment_channel`, `authorized_date`, `authorized_datetime`, `datetime`, `transaction_code`

**Code changes:**
- `transactionToRow()` → only extract kept columns + set `raw = JSON.stringify(fullProviderObject)`
- `rowToTransaction()` → merge `row.raw` with label columns to reconstruct JSONTransaction
- Remove flattened field mapping for location/payment_meta/etc.

### 2.2 Accounts Table

**Current: 21 columns → New: 14 columns + 1 JSONB = 15 (saves 6)**

Keep as columns:
```
account_id VARCHAR(255) PRIMARY KEY        -- PK, queried
user_id UUID                               -- FK, queried
item_id VARCHAR(255)                       -- queried, indexed
institution_id VARCHAR(255)                -- queried, indexed
name VARCHAR(255)                          -- displayed, useful for queries
type VARCHAR(50)                           -- useful for filtering
subtype VARCHAR(100)                       -- useful for filtering
custom_name TEXT                           -- user-edited
hide BOOLEAN                               -- user-edited
label_budget_id UUID                       -- user-edited
graph_options_use_snapshots BOOLEAN        -- user-edited
graph_options_use_transactions BOOLEAN     -- user-edited
raw JSONB                                  -- full provider object (balances, mask, official_name, etc.)
updated TIMESTAMP
is_deleted BOOLEAN
```

Remove (moved into `raw`):
- `balances_available`, `balances_current`, `balances_limit`, `balances_iso_currency_code`, `balances_unofficial_currency_code`
- `mask`, `official_name`

**Code changes:**
- `accountToRow()` → only extract kept columns + set `raw`
- `rowToAccount()` → merge `row.raw` with user-edited columns
- Sync logic: preserve user-edited fields when updating from provider

### 2.3 Securities Table

**Current: 28 columns → New: 10 columns + 1 JSONB = 11 (saves 17)**

Keep as columns (including fields useful for upcoming investment features):
```
security_id VARCHAR(255) PRIMARY KEY       -- PK, queried
name VARCHAR(255)                          -- displayed
ticker_symbol VARCHAR(50)                  -- queried
type VARCHAR(50)                           -- displayed
close_price DECIMAL(15, 6)                 -- displayed, tracked
close_price_as_of TIMESTAMP               -- displayed
iso_currency_code VARCHAR(10)              -- displayed
isin VARCHAR(50)                           -- queried
cusip VARCHAR(50)                          -- queried
raw JSONB                                  -- full provider object
updated TIMESTAMP
```

Remove (moved into `raw`):
- `sedol`, `institution_security_id`, `institution_id`, `proxy_security_id`
- `is_cash_equivalent`, `unofficial_currency_code`, `market_identifier_code`
- `sector`, `industry`, `subtype`
- `option_contract_type`, `option_expiration_date`, `option_strike_price`, `option_underlying_ticker`
- `fixed_income_yield_rate`, `fixed_income_maturity_date`, `fixed_income_issue_date`, `fixed_income_face_value`

### 2.4 Holdings Table

**Current: 13 columns → New: 11 columns + 1 JSONB = 12 (saves 1)**

Keep as columns (most fields are useful for investment tracking):
```
holding_id VARCHAR(255) PRIMARY KEY        -- PK, queried
user_id UUID                               -- FK, queried
account_id VARCHAR(255)                    -- queried, indexed
security_id VARCHAR(255)                   -- queried, indexed
institution_price DECIMAL(15, 6)           -- displayed, tracked
institution_value DECIMAL(15, 2)           -- displayed, tracked
cost_basis DECIMAL(15, 2)                  -- displayed, tracked
quantity DECIMAL(15, 6)                    -- displayed, tracked
iso_currency_code VARCHAR(10)              -- displayed
raw JSONB                                  -- full provider object
updated TIMESTAMP
is_deleted BOOLEAN
```

Remove (moved into `raw`):
- `institution_price_as_of`, `unofficial_currency_code`

Note: Holdings has minimal savings because most fields are needed for investment display. The `raw` column is still valuable for forward-compatibility.

### 2.5 Investment Transactions Table

**Current: 16 columns → New: 12 columns + 1 JSONB = 13 (saves 3)**

Keep as columns:
```
investment_transaction_id VARCHAR(255) PRIMARY KEY
user_id UUID
account_id VARCHAR(255)                    -- queried, indexed
security_id VARCHAR(255)                   -- displayed
date DATE                                  -- queried, indexed
name TEXT                                  -- displayed
amount DECIMAL(15, 2)                      -- displayed
quantity DECIMAL(15, 6)                    -- displayed
price DECIMAL(15, 6)                       -- displayed
type VARCHAR(50)                           -- displayed
raw JSONB                                  -- full provider object
updated TIMESTAMP
is_deleted BOOLEAN
```

Remove (moved into `raw`):
- `fees`, `subtype`, `iso_currency_code`, `unofficial_currency_code`

### 2.6 Split Transactions Table — No change needed

Split transactions don't receive provider data — they're entirely user-created. The current structure is already lean. No `raw` column needed.

### 2.7 Snapshots Table — No change

Keep as-is. Snapshot columns are used for aggregation (SUM) and multi-type storage makes raw JSONB awkward.

### 2.8 Items Table — Add raw JSONB only

Items are small (few columns), but adding `raw JSONB` is useful for forward-compatibility with new Plaid/SimpleFin fields.

### 2.9 Institutions Table — Add raw JSONB only

Same reasoning. Store full institution data for forward-compatibility.

### Summary of Column Reduction

| Table | Before | After | Saved |
|-------|--------|-------|-------|
| transactions | 39 | 14 | 25 |
| accounts | 21 | 15 | 6 |
| securities | 28 | 11 | 17 |
| holdings | 13 | 12 | 1 |
| investment_transactions | 16 | 13 | 3 |
| items | (add raw) | +1 | 0 |
| institutions | (add raw) | +1 | 0 |
| **Total** | **~137** | **~85** | **~52** |

### Checklist — Change #2
- [ ] Update `initialize.ts` — remove columns, add `raw JSONB` to tables
- [ ] Update `transactions.ts`:
  - [ ] Simplify `transactionToRow()` — only extract kept columns + raw
  - [ ] Rewrite `rowToTransaction()` — merge raw JSONB + label columns
  - [ ] Same for investment transaction row converters
- [ ] Update `accounts.ts`:
  - [ ] Simplify `accountToRow()` / `rowToAccount()`
  - [ ] Ensure user-edited fields merge correctly over raw
- [ ] Update `accounts.ts` for securities:
  - [ ] Simplify security row converters
- [ ] Update `accounts.ts` for holdings:
  - [ ] Simplify holding row converters
- [ ] Update `items.ts` — add raw JSONB storage
- [ ] Update SimpleFin translators (`src/server/lib/simple-fin/translators.ts`)
  - [ ] Ensure translated objects are stored in raw JSONB
- [ ] Update Plaid sync (`src/server/lib/compute-tools/sync-plaid.ts`)
  - [ ] Store full Plaid response objects in raw
- [ ] Update SimpleFin sync (`src/server/lib/compute-tools/sync-simple-fin.ts`)
- [ ] Update migration tool (`src/tools/migrate-es-to-postgres.ts`)
  - [ ] Map old flattened columns into raw JSONB during migration
- [ ] Run `npx tsc --noEmit` — verify all API response types still match
- [ ] Verify: GET /transactions returns same JSONTransaction shape
- [ ] Verify: GET /accounts returns same JSONAccount shape
- [ ] Verify: GET /budgets returns same JSONBudget shape (with capacities)

---

## Change #3: Capacities Table

### 3.1 New Table Schema

```sql
CREATE TABLE IF NOT EXISTS capacities (
  capacity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(user_id) ON DELETE RESTRICT,
  parent_id UUID NOT NULL,
  parent_type VARCHAR(20) NOT NULL CHECK (parent_type IN ('budget', 'section', 'category')),
  month DECIMAL(15, 2) DEFAULT 0,
  active_from DATE,
  updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_deleted BOOLEAN DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_capacities_user_id ON capacities(user_id);
CREATE INDEX IF NOT EXISTS idx_capacities_parent ON capacities(parent_id, parent_type);
```

### 3.2 Remove capacities JSONB from parent tables

Remove `capacities JSONB DEFAULT '[]'` column from:
- `budgets` table
- `sections` table
- `categories` table

### 3.3 Server-side: Reconstruct inline capacities on read

The API must still return `{ budget_id, name, capacities: [...], ... }`.

**Read path (getBudgets, getSections, getCategories):**
- After fetching budgets/sections/categories, do a second query to fetch their capacities
- Group capacities by `parent_id` and attach to parent objects
- Return the same `JSONBudget` / `JSONSection` / `JSONCategory` shapes

**Write path (upsertBudgets, createBudget, etc.):**
- Extract `capacities` array from incoming data
- Upsert parent entity without capacities column
- Upsert each capacity into the capacities table with `parent_id` and `parent_type`

**Delete path:**
- When soft-deleting a budget/section/category, also soft-delete its capacities

### 3.4 Update common model types

**File:** `src/common/models/BudgetFamily.ts`

```typescript
export interface JSONCapacity {
  capacity_id: string;  // Now a UUID from Postgres
  month: number;
  active_from?: string;
}
```

No structural change needed — `capacity_id` is already typed as `string`, which works for both hex and UUID.

**File:** `src/client/lib/models/Capacity.ts`

Change default ID generation:
```typescript
// Before:
capacity_id = getRandomId();

// After:
capacity_id = crypto.randomUUID();
```

This is a client-side model definition change (allowed per guidelines). The ID is a placeholder that gets replaced by the server-generated UUID on save.

### 3.5 Migration tool

Add Phase 6.5 to `migrate-es-to-postgres.ts`:
- After migrating budgets/sections/categories, extract capacities from their JSONB
- Insert each capacity into the new capacities table with proper `parent_id` mapping

### Checklist — Change #3
- [ ] Add capacities table to `initialize.ts`
- [ ] Remove `capacities JSONB` column from budgets, sections, categories tables
- [ ] Create `src/server/lib/postgres/capacities.ts`:
  - [ ] `getCapacitiesByParent(parent_id, parent_type)`
  - [ ] `getCapacitiesByParents(parent_ids, parent_type)` (batch for efficiency)
  - [ ] `upsertCapacities(user, parent_id, parent_type, capacities[])`
  - [ ] `deleteCapacitiesByParent(user, parent_id)`
- [ ] Update `budgets.ts`:
  - [ ] `getBudgets()` — join/attach capacities
  - [ ] `getBudget()` — attach capacities
  - [ ] `upsertBudgets()` — extract and upsert capacities separately
  - [ ] `createBudget()` — insert capacities after budget creation
  - [ ] `deleteBudget()` — also soft-delete capacities
  - [ ] Same for all section/category CRUD functions
- [ ] Update `src/client/lib/models/Capacity.ts` — use `crypto.randomUUID()`
- [ ] Update migration tool — extract JSONB capacities into new table
- [ ] Export new functions from `src/server/lib/postgres/index.ts`
- [ ] Run `npx tsc --noEmit` — verify JSONBudget/JSONSection/JSONCategory types still work
- [ ] Verify: GET /budgets returns budgets with inline capacities array
- [ ] Verify: POST /budget with capacities persists to capacities table

---

## Implementation Order

Execute in this order to minimize conflicts:

1. **Change #1 (Soft delete)** — schema-level change, touches initialize.ts + delete functions
2. **Change #3 (Capacities table)** — new table + modify budget CRUD, no overlap with #2
3. **Change #2 (Hybrid JSONB)** — largest change, touches most postgres modules

### After each change:
```bash
npx tsc --noEmit          # Type check
npm test                   # Unit tests (if any)
```

### Final verification:
- Start the app, create a budget with capacities, verify API responses
- Trigger a Plaid/SimpleFin sync, verify transactions/accounts stored correctly
- Delete a budget, verify sections/categories NOT cascade-deleted
- Check that `raw` JSONB contains full provider data
- Run migration tool on test ES data, verify all data migrates correctly

---

## Files Modified (Complete List)

### Change #1
- `src/server/lib/postgres/initialize.ts`
- `src/server/lib/postgres/users.ts`
- `src/server/lib/postgres/snapshots.ts`

### Change #2
- `src/server/lib/postgres/initialize.ts`
- `src/server/lib/postgres/transactions.ts`
- `src/server/lib/postgres/accounts.ts` (accounts, holdings, securities, institutions)
- `src/server/lib/postgres/items.ts`
- `src/server/lib/postgres/snapshots.ts` (if institution/security converters affected)
- `src/server/lib/simple-fin/translators.ts`
- `src/server/lib/compute-tools/sync-plaid.ts`
- `src/server/lib/compute-tools/sync-simple-fin.ts`
- `src/tools/migrate-es-to-postgres.ts`

### Change #3
- `src/server/lib/postgres/initialize.ts`
- `src/server/lib/postgres/budgets.ts`
- `src/server/lib/postgres/capacities.ts` (NEW)
- `src/server/lib/postgres/index.ts`
- `src/client/lib/models/Capacity.ts` (model definition only)
- `src/common/utils/index.ts` (optional: deprecate getRandomId)
- `src/tools/migrate-es-to-postgres.ts`

---

## Migration Lessons Learned

### 1. ID Mapping Must Cover All References

When migrating from ES to PostgreSQL with new UUIDs, ALL ID references must be mapped:
- **Transaction labels** (`label_budget_id`, `label_category_id`)
- **Account labels** (`label_budget_id`)
- **Section → Budget** (`budget_id`)
- **Category → Section** (`section_id`)
- **Capacity → Parent** (`parent_id`)
- **Split transaction labels**
- **Chart configuration** (`budget_ids` array inside JSON)

### 2. JSON String vs Object

ES stores some nested objects as JSON strings. Always check the type before accessing properties:

```javascript
// WRONG - if configuration is a string, this silently fails
const config = chart.configuration || {};
config.budget_ids = config.budget_ids.map(...);

// CORRECT - parse if string
let config = chart.configuration || {};
if (typeof config === 'string') {
  config = JSON.parse(config);
}
config.budget_ids = config.budget_ids.map(...);
```

### 3. Referential Integrity Checks

The migration tool now includes comprehensive integrity checks at the end:
- All foreign keys are validated
- Chart configuration budget_ids are validated against the budgets table
- Any orphaned references are reported

**Always verify the integrity checks pass before declaring migration complete.**

### 4. Capacity Numeric Overflow

ES used `MAX_FLOAT` (~3.4e38) as a sentinel for "unlimited" capacity. PostgreSQL `DECIMAL(15,2)` max is ~9.99e12. The migration clamps these values. Consider using `-1` or `NULL` to represent unlimited in future schemas.
