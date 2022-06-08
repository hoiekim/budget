FROM node:14.17.6-alpine3.13

WORKDIR /app

COPY . .
RUN npm i --only=prod
RUN npm run build

CMD ["npm", "run", "start-server"]