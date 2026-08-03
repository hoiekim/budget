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

`ci.yml`'s `test` job runs ESLint (`bun run lint`), TypeScript
(`bun run typecheck`) and the suite with coverage thresholds
(`bun run test:coverage`). A `build` job runs `bun run build` after it
(`needs: test`).

### Where the checks actually gate

There are two independent places the checks run, and they cover different
risks:

| Trigger | Runs | Gates |
|---------|------|-------|
| `ci.yml` on `pull_request: [main]` | lint, typecheck, test **with coverage thresholds**, build | Nothing mechanically — it is a visible signal on the PR. `main`'s ruleset requires a review and thread resolution, but has no required status check, so a red run does not block the merge button |
| `Dockerfile` builder stage, via `cd.yml` on `push: [main]` | lint, typecheck, test, build | The deploy — `docker-push` fails, and `deploy` is `needs: docker-push`, so nothing ships |

**The builder stage is the only mechanical gate.** Merges land via PR, so the
PR checks run on every commit that reaches `main` — but running is not the
same as passing, and nothing today enforces that they were green. What
enforces correctness is the second row: the same check set re-runs against
the merged commit inside the Docker build, so a squash-merge that combines
two individually-green PRs into a broken result fails the image build and
never reaches production.

The two sets are not quite identical. `ci.yml` runs `test:coverage`, which
also enforces the thresholds in `scripts/check-coverage.ts`; the builder
stage runs plain `test`. A coverage regression is therefore caught on the PR
only.

### Decision: CI does not trigger on `push: [main]`

`ci.yml` deliberately has no `push: branches: [main]` trigger. **Do not add
one.** It has been proposed and rejected twice — #438, closed 2026-06-07,
and #560, implemented as #640 and pivoted away from. (#218 is adjacent but
distinct: it asked for branch protection, a `needs: ci` dependency, or
post-deploy rollback, not this trigger.) The reasoning:

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

Pre-merge enforcement, if it is ever wanted, is a repository setting — adding
the `test` / `build` contexts as required status checks on `main`'s ruleset,
or a merge queue — rather than a workflow change. That is what #218 asked for
and it remains available; it is a different change from the one rejected
here.
