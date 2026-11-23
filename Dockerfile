FROM oven/bun:1.4.4 AS builder

WORKDIR /app

COPY package.json bun.lockb* ./
COPY tsconfig.json tsconfig.node.json ./
COPY vite.config.ts eslint.config.js ./
COPY src src
COPY scripts scripts
COPY .env.example ./
COPY healthcheck.js ./

RUN bun install
RUN bun run lint
RUN bun run typecheck
RUN bun run test
RUN bun run build

# The Rust server (src/server-rust). The image's Rust is the version
# rust-toolchain.toml pins; that file stays out so the build needs no other.
FROM rust:1.97.0-slim-bookworm AS rust-builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY src/server-rust src/server-rust

RUN cargo build --release --locked --bin budget-server

FROM oven/bun:1.4.4

WORKDIR /app

COPY --chown=bun:bun --from=builder /app/build ./build
COPY --chown=bun:bun --from=rust-builder /app/target/release/budget-server ./build/server-rust/budget-server
COPY --chown=bun:bun healthcheck.js start.sh ./

USER bun

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD bun ./healthcheck.js

# BUDGET_SERVER=rust runs the Rust server instead of the Bun one (start.sh).
CMD ["sh", "./start.sh"]
