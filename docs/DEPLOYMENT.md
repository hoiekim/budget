# Deployment

## Production

Build and start the server:

```bash
bun run build-client
bun run build-server-rust
bun run start-server-rust
```

The server listens on port 3005. The Bun server (`src/server`) still builds
and starts as before: `bun run build`, then `bun run start-server`.

## Docker

```bash
docker-compose up -d
```

The app will be available at http://localhost:3005.

## CI/CD

Merges to `main` trigger:

1. Docker image build from `Dockerfile.rust` — its builder stages run `bun run lint`, `bun run typecheck`, `bun run test` and `bun run build-client`, then `cargo clippy`, `cargo test` and the server's release build (build fails if any of these fail)
2. Push to Docker Hub
3. Deployment webhook

CD builds the image with the Rust server (`src/server-rust`). `Dockerfile`
still builds the Bun server's image; going back to it is changing `file:` in
`cd.yml` to `./Dockerfile` (see "Running it in production" in
`src/server-rust/README.md`).

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
| `Dockerfile.rust` builder stages, via `cd.yml` on `push: [main]` | lint, typecheck, test, client build; Clippy, Rust unit tests, server build | The deploy — `docker-push` fails, and `deploy` is `needs: docker-push`, so nothing ships |

**The image's builder stages are the only mechanical gate.** Every commit that reaches
`main` came from a PR that had the checks run against it — but not against
the merged result. `ci.yml` triggers only on `pull_request`, so it runs
against the PR's ephemeral merge ref, a different SHA from the squash commit
that lands, and different *content* whenever `main` advances between the last
PR run and the merge. Nothing enforces that those runs were green either.
What enforces correctness is the second row: the same TypeScript checks minus
the coverage threshold, and the Rust server's Clippy and unit tests, re-run
against the merged commit inside the Docker build,
so a squash-merge that combines two individually-green PRs into a broken
result fails the image build and never reaches production.

The two sets are not quite identical. `ci.yml` runs `test:coverage`, which
also enforces the thresholds in `scripts/check-coverage.ts`; the builder
stage runs plain `test`. A coverage regression is therefore caught on the PR
only. So is a difference between the two servers' answers: the conformance
suite needs a database, so only `ci.yml` runs it.

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
  PR run ever saw — is already caught by the image's builder stages, which
  run the full check set against exactly that merged commit and fail the
  deploy.
- It would newly cover nothing. The only pushes a `push: [main]` trigger adds
  over `pull_request` are direct pushes to `main`, and `main`'s ruleset
  (`protect_main`, `enforcement: active`, a `pull_request` rule and no bypass
  actors) forbids those for every actor, owner included.

Pre-merge enforcement, if it is ever wanted, is a repository setting — adding
the `test` / `build` contexts as required status checks on `main`'s ruleset,
or a merge queue — rather than a workflow change. It is a different change
from the one rejected here, and nothing currently tracks it: #218 asked for
it but was closed as completed by #221, which only bumped action versions, so
the required-status-check option was never actually implemented. Treat it as
untracked, not as a live item.
