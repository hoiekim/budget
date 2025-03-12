# What is Budget?

See [live demo](https://budget.hoie.kim)! (username: `demo`, password: `budget`)

Budget is a web app that provides features for tracking your financial acounts and transactions. We aim to develop a tool for users to understand their money flow and establish long-term plan. We use 3rd party API provided by [Plaid](https://plaid.com/) and [SimpleFin](https://www.simplefin.org)

# How do I setup Budget?

## Option 1: Using Docker

Use `docer-compose.yml` to quick start budget in one command:

```
docker-compose up -d
```

Now Budget app should be live [here](http://localhost:3005). Take a look!

## Option 2: Using Node.js

First, download Budget with this command in your terminal. This command will create `budget` folder and download all files in this repository.

```
git clone https://github.com/hoiekim/budget.git
```

Create `.env.local` file in the root of budget directory.

```
cd ./budget
cp .env.example .env.local
```

(See more details about how to configure correct environment variables in the next section.)

Make sure you have [npm](https://npmjs.com) installed in your machine and available in your terminal. Then use this command to install Budget.

```
cd budget
npm install
```

Then use this command to run Budget.

```
npm start
```

Now Budget app should be live [here](http://localhost:3005). Take a look!

## Set up environment variables

We need some environment configuration. Copy the content of `.env.example` file and save it as `.env.local`. This file should contain environment variables and Budget will try to read them once you run it. You need to keep the keys but use your own values depend on your environment. See below for how to determine correct environment variables.

- `ADMIN_PASSWORD` is password that you will use when login to Budget as administrator user. Choose one that you would like.

- `ELASTICSEARCH_HOST` is an address to an Elasticsearch server. You can download it from their [official website](https://elastic.co) for free and install it on your local machine. Or consider using free external hosting service, [Learndatabases](https://learndatabases.dev).

- (optional) `PLAID_CLIENT_ID`, `PLAID_SECRET_PRODUCTION` are kinds of password that you need to request data from Plaid API. Go to [Plaid](https://plaid.com), sign up and get your secret key. You don't need this if you use SimpleFin to connect bank accounts.

- (optional)`HOST_NAME` is the domain name that you will host budget app. This is required for OAuth when using Plaid.

- (optional) `POLYGON_API_KEY` is the secret key to interact with [Polygon API](https://polygon.io/docs/stocks/getting-started) to request metadata for invetment items. This is used to create snapshots when the metadata is not available from your account or transaction data provider(Plaid or SimpleFin).

# How to contribute

Create an [issue](https://github.com/hoiekim/budget/issues/new) and explain how you want to improve this project. Or send us an email to budget@hoie.kim if you feel shy. We welcome your ideas!
