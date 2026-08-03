# Deployment

## Production

Build and start the server:

```bash
bun run build
bun run start-server
```

The server listens on port 3005.

## Docker

```bash
docker-compose up -d
```

The app will be available at http://localhost:3005.

## CI/CD

Merges to `main` trigger:

1. Docker image build — the Dockerfile builder stage runs `bun run lint`, `bun run typecheck`, `bun run test`, and `bun run build` (build fails if any of these fail)
2. Push to Docker Hub
3. Deployment webhook

### Pull Request Checks

- TypeScript type checking (`bun run typecheck`)
- ESLint linting (`bun run lint`)
- Unit tests (`bun run test`)

### Where the checks actually gate

There are two independent places the checks run, and they cover different
risks:

| Trigger | Runs | Gates |
|---------|------|-------|
| `ci.yml` on `pull_request: [main]` | lint, typecheck, test, build | The merge — a red check is visible on the PR before it lands |
| `Dockerfile` builder stage, via `cd.yml` on `push: [main]` | lint, typecheck, test, build | The deploy — `docker-push` fails, and `deploy` is `needs: docker-push`, so nothing ships |

Because merges land only via PR, every commit on `main` has already passed
the PR checks. And because the deploy path re-runs the same checks against
the merged commit inside the Docker build, a squash-merge that combines two
individually-green PRs into a broken result fails the image build and never
reaches production.

### Decision: CI does not trigger on `push: [main]`

`ci.yml` deliberately has no `push: branches: [main]` trigger. **Do not add
one.** This has been proposed at least three times (#218, #438, #560/#640)
and rejected each time. The reasoning:

- A `push` trigger fires *after* the commit is already on `main`, so it
  prevents nothing. It is a detector, not a gate.
- It would not block a bad deploy either: it runs in parallel with `cd.yml`,
  which does not depend on it.
- The failure mode it claims to catch — a squash-merge producing a state no
  PR run ever saw — is already caught by the Dockerfile builder stage, which
  runs the full check set against exactly that merged commit and fails the
  deploy.
- The only pushes it would newly cover are direct pushes to `main`, which are
  maintainer overrides and intentionally exempt.

Pre-merge enforcement, if it is ever wanted, is a repository setting (required
status checks / merge queue) rather than a workflow change.
