FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lockb* ./
COPY tsconfig.json tsconfig.node.json ./
COPY vite.config.ts ./
COPY src src
COPY public public
COPY index.html ./

RUN bun install
RUN bun run typecheck
RUN bun run test
RUN bun run build

FROM oven/bun:1

WORKDIR /app

COPY --from=builder /app/build ./build

# Environment variables should be provided at runtime, not baked into the image.
# Use: docker run --env-file .env ...
# Or Docker Compose: env_file: - .env
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3005/api/health || exit 1

CMD ["bun", "./build/server/bundle.js"]
