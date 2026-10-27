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
# NODE_ENV is folded into the server bundle at build time (see
# scripts/build-posture-probe.ts). The empty default keeps the artifact
# neutral: a builder that wants the production posture passes
# --build-arg NODE_ENV=production. Never default this to production here —
# that would bake a posture into every image built from this repo.
ARG NODE_ENV=
ENV NODE_ENV=${NODE_ENV}
RUN bun run build

FROM oven/bun:1.4.4

WORKDIR /app

COPY --chown=bun:bun --from=builder /app/build ./build
COPY --chown=bun:bun healthcheck.js ./healthcheck.js

USER bun

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD bun ./healthcheck.js

CMD ["bun", "./build/server/bundle.js"]
