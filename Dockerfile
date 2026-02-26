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
RUN bun test
RUN bun run build

FROM oven/bun:1

WORKDIR /app

COPY --from=builder /app/build ./build

# Environment variables should be provided at runtime, not baked into the image.
# Use: docker run --env-file .env ...
# Or Docker Compose: env_file: - .env
CMD ["bun", "./build/server/bundle.js"]
