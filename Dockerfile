FROM --platform=linux/AMD64 node:14.17.6-alpine3.13 AS BUILDER

WORKDIR /app

COPY . .
RUN npm i
RUN npm run build
RUN npm prune --production

FROM --platform=linux/AMD64 node:14.17.6-alpine3.13

WORKDIR /app

COPY --from=BUILDER /app/build ./build
COPY --from=BUILDER /app/compile ./compile
COPY --from=BUILDER /app/node_modules ./node_modules

CMD ["node", "./compile/server/index.js"]