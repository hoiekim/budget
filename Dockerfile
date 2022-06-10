FROM --platform=linux/AMD64 node:14.17.6-alpine3.13 AS BUILDER

WORKDIR /app

COPY . .
RUN npm i
RUN npm run build
RUN npm prune --production

FROM --platform=linux/AMD64 node:14.17.6-alpine3.13

WORKDIR /app

COPY .env .env
COPY --from=BUILDER /app/node_modules ./node_modules
COPY --from=BUILDER /app/build ./build
COPY --from=BUILDER /app/server/build ./server/build

CMD ["node", "./server/build/index.js"]