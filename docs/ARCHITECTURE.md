# Architecture

## Tech Stack

- **Frontend**: React (TypeScript), built with Vite
- **Backend**: Bun HTTP server (TypeScript)
- **Database**: PostgreSQL
- **Containerization**: Docker
- **External APIs**: Plaid, SimpleFin, Polygon

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
- **Snapshot** — point-in-time record of account balances
- **Chart** — visualization configuration
- **TransferPair** — pairs two transactions across accounts as a single transfer (suggested or confirmed)

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
| `0 < c < 1` | Auto-suggest applied a label — user has not yet confirmed or rejected | Grey dot in `TransactionRow` |
| `1` | User explicitly confirmed | No dot |

A prod backfill on 2026-05-13 set `label_category_confidence = 1` for every labeled row in `transactions`, so the `(category_id IS NOT NULL, confidence IS NULL)` combination is no longer expected in production data.

**Confirmation predicate.** Anywhere that distinguishes "user-confirmed" from "still suggested" uses:

```typescript
const isConfirmed = category_confidence === 1 && !!category_id;
```

Used in `src/client/lib/hooks/calculation/budgets.ts` (budget-bar / unsorted-count) and `src/client/pages/TransactionsPage/index.tsx` (the `unsorted` filter). The `&& !!category_id` guard exists so a malformed `confidence=1, category_id=null` row goes to the unsorted bucket rather than into a `categories.get(null)` lookup that would silently drop it.

**Split transactions and confidence.** The `split_transactions` table does not carry `label_category_confidence` — it only has `label_category_id` and `label_budget_id`. When budget calc folds splits into the family via `SplitTransaction.toTransaction()`, the resulting label has `category_confidence === undefined`, which fails the `=== 1` check above. Splits with a category set therefore currently fall into the unsorted bucket in budget-bar / unsorted-count math. This is a known limitation tracked separately from the data-model backfill.

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
