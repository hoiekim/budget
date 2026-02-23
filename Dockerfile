FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lockb* ./
COPY tsconfig.json tsconfig.node.json ./
COPY vite.config.ts ./
COPY src src
COPY public public
COPY index.html ./
COPY .env .env

RUN bun install
RUN bun run typecheck
RUN bun test
RUN bun run build

FROM oven/bun:1

WORKDIR /app

COPY --from=builder /app/build ./build

CMD ["bun", "./build/server/bundle.js"]
