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

Copy `.env.example` to `.env.local` and fill in values:

| Variable | Required | Description |
|---|---|---|
| `ADMIN_PASSWORD` | Yes | Password for the admin user |
| `POSTGRES_HOST` | Yes | Address to your PostgreSQL server |
| `POSTGRES_PORT` | No | PostgreSQL port (default: 5432) |
| `POSTGRES_USER` | No | PostgreSQL user |
| `POSTGRES_PASSWORD` | No | PostgreSQL password |
| `POSTGRES_DB` | No | PostgreSQL database name |
| `PLAID_CLIENT_ID` | No | Plaid API client ID (for Plaid bank connections) |
| `PLAID_SECRET_PRODUCTION` | No | Plaid API secret (for Plaid bank connections) |
| `HOST_NAME` | No | Domain name for hosting (required for Plaid OAuth) |
| `POLYGON_API_KEY` | No | Polygon.io API key (for investment metadata) |
| `DISCORD_ALARM_WEBHOOK` | No | Discord webhook URL for server error alerts |

> **Note on `NODE_ENV`:** Bun bakes `NODE_ENV` at build time into the output bundle. Setting it via `docker run -e` at runtime has no effect — configure environment-dependent behavior through other env vars.
