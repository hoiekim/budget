FROM --platform=linux/AMD64 node:18.15.0-alpine3.17 AS BUILDER

WORKDIR /app

COPY package.json package.json
COPY package-lock.json package-lock.json
COPY tsconfig.json tsconfig.json
COPY tsconfig.server.json tsconfig.server.json
COPY src src
COPY public public
COPY .env .env

RUN npm i
RUN npm run build
RUN npm prune --production

FROM --platform=linux/AMD64 node:18.15.0-alpine3.17

WORKDIR /app

COPY --from=BUILDER /app/build ./build
COPY --from=BUILDER /app/node_modules ./node_modules

CMD ["node", "./build/server/bundle.js"]