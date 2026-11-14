# Architecture

## Tech Stack

- **Frontend**: React (TypeScript), built with Vite
- **Backend**: Bun HTTP server (TypeScript)
- **Database**: PostgreSQL
- **Containerization**: Docker
- **External APIs**: Plaid, SimpleFin, Polygon, BLS

## Project Structure

```
budget/
├── src/
│   ├── client/               # Frontend React application
│   │   ├── components/       # Reusable UI components
│   │   ├── pages/            # Page components
│   │   ├── lib/              # Frontend utilities, hooks, models
│   │   ├── public/           # Static assets (icons, manifest, splash screens)
│   │   ├── index.html        # HTML entry point
│   │   ├── start.tsx         # JS entry point
│   │   └── sw.ts             # Service worker
│   ├── server/               # Backend server
│   │   ├── lib/              # Server utilities and integrations
│   │   │   ├── postgres/     # PostgreSQL client and operations
│   │   │   ├── plaid/        # Plaid API integration
│   │   │   ├── simple-fin/   # SimpleFin API integration
│   │   │   └── compute-tools/  # Data processing utilities
│   │   └── routes/           # API endpoints
│   │       ├── accounts/     # Account management
│   │       ├── api-keys/     # Scoped API key management
│   │       ├── budgets/      # Budget management
│   │       ├── charts/       # Chart data
│   │       ├── transfers/    # Transfer pair management
│   │       ├── users/        # User management
│   │       └── webhooks/     # Webhook handlers
│   └── common/               # Shared code (client + server)
│       ├── models/           # Data models and types
│       └── utils/            # Shared utilities
├── docs/                     # Documentation
├── build/                    # Compiled output
└── _manual_tools/            # Development and maintenance scripts
```

## Data Models

Core models are defined in `src/common/models/`:

- **Account** — a financial account
- **Transaction** — a financial transaction
- **Budget / BudgetFamily** — budget plans and groupings
- **Item** — a connection to a financial institution
- **Snapshot** — point-in-time record of account balances, holdings, or security prices (discriminated by `snapshot_type`)
- **Chart** — visualization configuration
- **TransferPair** — pairs two transactions across accounts as a single transfer (suggested or confirmed)
- **CpiSnapshot** — one month of the BLS Consumer Price Index (global, not user-scoped; table `cpi_snapshots`)

### Projection Chart: Auto Goal Configuration

A projection chart's goal (living cost, its as-of date, tax rate, and yearly inflation) is either typed in, or — with `auto_goal_config` on — inferred on the client by `inferGoalConfig` (`src/client/lib/charts.ts`) through the `useGoalConfig` hook:

| Field | Source when auto | Fallback |
|---|---|---|
| Living cost | Sum of the monthly amounts of the budgets in `configuration.budget_ids` at today (income and unlimited budgets skipped) | Stored manual value when no selected budget contributes |
| Living cost as of | Latest `active_from` among those budgets' active capacities ("periods"), walking into children for synced capacities | Start of the current month when no period is dated |
| YoY inflation | `GET /api/inflation` — compound annual CPI-U growth over the last 30 years of stored history (`server/lib/inflation.ts`) | Stored manual value until the CPI backfill has a year of data |
| Tax rate | Federal + state income tax on 12 × living cost (carried to current dollars), single filer, standard deduction (`common/utils/tax.ts`) | Federal only when no state can be inferred |

The residence state is the U.S. state that appears most often in `location.region` across the past 365 days of transactions (`inferResidenceState`). Tax tables live in `common/utils/tax-tables.ts` and are for one tax year (`TAX_YEAR`); local income taxes, payroll taxes, and phase-outs are out of scope. The manual values stay stored, so turning auto off restores them.

### Transaction Categorization (Auto-Suggest)

A transaction carries three correlated fields that together describe its current categorization state:

| Field | Type | Meaning |
|---|---|---|
| `label_category_id` | UUID \| null | The category the transaction is labeled under |
| `label_budget_id` | UUID \| null | The parent budget for `label_category_id` — written alongside it so the UI's category `<select>` (which filters options by budget) can render the value |
| `label_category_confidence` | number \| null | Confidence in [0, 1]; `null` means unlabeled |

The `label_category_confidence` field encodes four distinct states:

| Confidence | Meaning | UI signal |
|---|---|---|
| `null` | Unlabeled (`label_category_id IS NULL`) | Red dot in `TransactionRow` |
| `0` | User rejected a prior suggestion | Counted as a rejection signal for that merchant |
| `0 < c < 1` | Auto-suggest applied a label — user has not yet confirmed or rejected | Yellow dot in `TransactionRow` |
| `1` | User explicitly confirmed | No dot |

A prod backfill on 2026-05-13 set `label_category_confidence = 1` for every labeled row in `transactions`, so the `(category_id IS NOT NULL, confidence IS NULL)` combination is no longer expected in production data.

**Confirmation predicate.** Anywhere that distinguishes "user-confirmed" from "still suggested" uses:

```typescript
const isConfirmed = category_confidence === 1 && !!category_id;
```

Used in `src/client/lib/hooks/calculation/budgets.ts` (budget-bar / unsorted-count) and `src/client/pages/TransactionsPage/index.tsx` (the `unsorted` filter). The `&& !!category_id` guard exists so a malformed `confidence=1, category_id=null` row goes to the unsorted bucket rather than into a `categories.get(null)` lookup that would silently drop it.

**Split transactions and confidence.** `split_transactions` carries `label_category_confidence` alongside `label_category_id` and `label_budget_id`, mirroring `transactions`. When budget calc folds splits into the family via `SplitTransaction.toTransaction()`, the split's own label flows through the `isConfirmed` check, so a user-confirmed split (`confidence === 1`) lands in the sorted bucket and an auto-suggested split (`0 < confidence < 1`) lands in unsorted. The route layer applies `inferLabelConfidence` (see `src/server/lib/infer-label-confidence.ts`) on `POST /split-transaction` to write `1` when the user explicitly sets a category and `0` when they clear it.

**Auto-suggest pipeline.** Suggestions are written by the hourly background job in `src/server/lib/compute-tools/auto-suggest.ts` (`runAutoSuggestions`), scheduled from `schedule.ts`'s `scheduledSync`. Per-merchant signal scoring (`evaluateSignal`) is documented in [DESIGN_PATTERNS.md](DESIGN_PATTERNS.md#auto-suggest-merchant-signal-scoring).

## External API Integrations

### Plaid

Connects to financial institutions to fetch account and transaction data. Integration lives in `src/server/lib/plaid/`.

### SimpleFin

An alternative bank connection method using the [SimpleFin Bridge Protocol](https://www.simplefin.org/protocol.html):

1. **Setup token** → base64-decoded URL → POST exchange → access URL
2. **Access URL** → embedded credentials → Basic auth for data fetching
3. **Data translation** → SimpleFin types mapped to internal Plaid-compatible types

Key files:
- `src/server/lib/simple-fin/tokens.ts` — token exchange and URL decoding
- `src/server/lib/simple-fin/data.ts` — data fetching
- `src/server/lib/simple-fin/translators.ts` — type mapping to internal models
- `src/server/lib/compute-tools/sync-simple-fin.ts` — sync orchestration

### Polygon

Fetches metadata for investment items when not available from Plaid or SimpleFin. Integration in `src/server/lib/polygon.ts`.

### BLS (Bureau of Labor Statistics)

Supplies CPI-U history (series `CUUR0000SA0`, not seasonally adjusted) for the projection chart's auto inflation rate. Integration in `src/server/lib/bls.ts`; the job is `refreshCpiSnapshots` in `src/server/lib/compute-tools/refresh-cpi-snapshots.ts`, run from the hourly `scheduledSync` after the security-snapshot refresh.

- **Never on the request path.** `GET /api/inflation` reads `cpi_snapshots` only.
- **Backfill.** Any completed year in the 30-year window (+1 for the base month) with no stored month is requested — an empty table fills in one run (4 requests keyless, 2 with a key). Presence, not completeness, is tested, so a month BLS never published (October 2025) is not re-requested forever.
- **Refresh.** When the latest stored month is older than last month and nothing was written in the past 22 hours, the latest stored year through the current year is re-requested. Upserts re-stamp `updated`, which is the cadence gate, so it survives restarts.
- **Daily budget.** Every request draws on a rolling 24-hour budget — 10/day keyless (BLS cap 25), 50/day with `BLS_API_KEY` (cap 500). A run that hits it, or BLS's own "daily threshold" refusal, stops and leaves the rest to a later run.
