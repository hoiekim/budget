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
│   │       ├── budgets/      # Budget management
│   │       ├── charts/       # Chart data
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
