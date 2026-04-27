# Development

## Quick Start

```bash
bun install            # Install dependencies
bun run dev            # Start dev server (client + server)
bun run build          # Build for production
bun run start          # Build and start production server
bun run lint           # Run ESLint
bun run lint:fix       # Run ESLint with auto-fix
bun run typecheck      # Run TypeScript type checking
```

## Dev Server

Run client and server together:

```bash
bun run dev
```

Or separately:

```bash
bun run dev-client     # Vite dev server on :3000 (proxies /api to :3005)
bun run dev-server     # Bun server on :3005 with --watch
```

## Build

```bash
bun run build          # Build server + client
bun run build-server   # Server only (outputs to build/server/)
bun run build-client   # Client only (Vite, outputs to build/client/)
```

## Common Tasks

### Adding a New API Route

1. Create route file in `src/server/routes/<domain>/`
2. Export route instance using the `Route` class
3. Add to `src/server/routes/<domain>/index.ts`
4. Define the response type with `export type`

### Adding a New Component

1. Create folder in `src/client/components/`
2. Add `index.tsx` and optional `index.css`
3. Export from `src/client/components/index.ts`

### Adding Database Tables/Columns

Schema migrations run automatically on server startup. The migration system compares TypeScript model definitions with the actual database schema and adds missing columns.

1. Add model in `src/server/lib/postgres/models/`
2. Add repository in `src/server/lib/postgres/repositories/`
3. Define the schema in your model class
4. Server startup will automatically add any missing columns

**What's automatic:**
- Adding new columns to existing tables
- Detecting type mismatches (logged as warnings)

**What requires manual migration:**
- Dropping columns
- Renaming columns
- Changing column types
- Creating new tables (add to `initialize.ts`)

See `src/server/lib/postgres/migration.ts` for implementation details.

### Dark Mode CSS

The app is dark-mode only. When adding grey/neutral colors, use the transformation:

```
dark = 1 - 0.9 × light
```

Common mappings (light → dark):

| Light | Dark |
|---|---|
| `#fff` | `#0d0d0d` |
| `#eee` | `#111` |
| `#ddd` | `#1f1f1f` |
| `#ccc` | `#2d2d2d` |
| `#bbb` | `#3b3b3b` |
| `#aaa` | `#494949` |
| `#888` | `#636363` |
| `#666` | `#7b7b7b` |
| `#555` | `#888` |
| `#333` | `#a3a3a3` |

**Exception:** Elements with the `.colored` class use their original light-mode colors unchanged.
