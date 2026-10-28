# Getting Started

## Prerequisites

- [Bun](https://bun.sh) (v1.0 or higher) — JavaScript runtime and package manager
- Docker and Docker Compose (optional, for containerized setup)
- PostgreSQL instance (local or remote)

## Option 1: Docker

Use `docker-compose.yml` to start the app in one command:

```bash
docker-compose up -d
```

The app will be available at http://localhost:3005.

## Option 2: Bun

Clone the repository:

```bash
git clone https://github.com/hoiekim/budget.git
cd budget
```

Copy the example environment file and configure it:

```bash
cp .env.example .env.local
```

Install dependencies:

```bash
bun install
```

Start the app:

```bash
bun run start
```

The app will be available at http://localhost:3005.

## Environment Variables

Copy `.env.example` to `.env.local` and fill in values. `Required` means the value must be set for the deployment to work as described — a `No` row works unset via the documented default or fallback:

| Variable | Required | Description |
|---|---|---|
| `ADMIN_PASSWORD` | Yes | Password for the admin user. Unset falls back to the literal `budget`, the credential published for the public demo instance, so a private deployment must set it. |
| `DEMO_PASSWORD` | Yes | Password for the `demo` user, which is created on every startup alongside `admin`. Unset falls back to the literal `budget`, the credential published for the public demo instance, so a private deployment must set it. |
| `POSTGRES_HOST` | No | Address of your PostgreSQL server (default: `localhost`) |
| `POSTGRES_PORT` | No | PostgreSQL port (default: 5432) |
| `POSTGRES_USER` | No | PostgreSQL user |
| `POSTGRES_PASSWORD` | No | PostgreSQL password |
| `POSTGRES_DATABASE` | No | PostgreSQL database name (default: `budget`) |
| `PLAID_CLIENT_ID` | For Plaid | Plaid API client ID |
| `PLAID_SECRET_PRODUCTION` | For Plaid | Plaid API secret for the production environment |
| `PLAID_SECRET_DEVELOPMENT` | For Plaid | Plaid API secret for the development environment, used when `PLAID_SECRET_PRODUCTION` is unset |
| `PLAID_SECRET_SANDBOX` | For Plaid | Plaid API secret for the sandbox environment. The `demo` user is pinned to sandbox, so this is needed even on a deployment that only serves real accounts. |
| `HOST_NAME` | No | Domain name for hosting (required for Plaid OAuth) |
| `POLYGON_API_KEY` | For Polygon | Polygon.io API key (for investment metadata) |
| `POLYGON_RATE_LIMIT_PER_MIN` | No | Cap on outbound Polygon requests per minute (default: 5, which matches the free tier). `0` disables the gate. |
| `PORT` | No | HTTP port the server listens on (default: 3005) |
| `LOG_LEVEL` | No | Log verbosity, one of `debug`, `info`, `warn` or `error` (default: `info`, or `error` when `NODE_ENV=test`) |
| `DISCORD_ALARM_WEBHOOK` | No | Discord webhook URL for server error alerts |

> **Plaid is all-or-nothing.** The integration turns on only when `PLAID_CLIENT_ID` and `PLAID_SECRET_SANDBOX` are both set **and** at least one of `PLAID_SECRET_PRODUCTION` or `PLAID_SECRET_DEVELOPMENT` is set. Any other combination leaves Plaid off for every user, with one `Plaid is not configured` warning at startup and every authenticated link-token request failing with `Plaid integration is not configured on this server.`

> **Note on `NODE_ENV`:** Bun bakes `NODE_ENV` at build time into the output bundle. Setting it via `docker run -e` at runtime has no effect — configure environment-dependent behavior through other env vars.
