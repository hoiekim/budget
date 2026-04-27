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

1. Docker image build — the Dockerfile builder stage runs `bun run typecheck`, `bun run test`, and `bun run build` (build fails if any of these fail)
2. Push to Docker Hub
3. Deployment webhook

### Pull Request Checks

- TypeScript type checking (`bun run typecheck`)
- ESLint linting (`bun run lint`)
- Unit tests (`bun run test`)
