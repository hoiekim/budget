# What is Budget?

See [live demo](https://budget.hoie.kim)! (username: `demo`, password: `budget`)

Budget is a web app that provides features for monitoring your financial acounts and transactions. We aim to develop this project to be a tool for users to understand their money flow and plan easily. We use 3rd party API provided by [Plaid](https://plaid.com/) so you need Plaid account and credentials to setup Budget on your own environment.

# How do I setup Budget?

## Set up environment variables

We need some environment configuration. Copy the content of `.env.example` file and save it as `.env.local`. This file should contain environment variables and Budget will try to read them once you run it. You need to keep the keys but use your own values depend on your environment. See below for how to determine correct environment variables.

- `HOST_NAME` is the domain name that you will host budget app. This is required for OAuth.

- `ADMIN_PASSWORD` is password that you will use when login to Budget as administrator user. Choose one that you would like.

- `PLAID_CLIENT_ID` is a unique identifier for a Plaid user. Go to [Plaid](https://plaid.com), sign up and get your client id.

- `PLAID_SECRET_PRODUCTION`, `PLAID_SECRET_DEVELOPMENT` and `PLAID_SECRET_SANDBOX` are kinds of password that you need to request data from Plaid API. Go to [Plaid](https://plaid.com), sign up and get your secret key. If you set both of production and development key, production key will be used, otherwise development key.

- `ELASTICSEARCH_HOST` is an address to an Elasticsearch server. You can download it from their [official website](https://elastic.co) for free and install it on your local machine. Or consider using free external hosting service, [Learndatabases](https://learndatabases.dev).

## Option 1: Using Docker

Pull latest released image from [hoie/budget](https://hub.docker.com/r/hoie/budget).

```
docker pull hoie/budget
```

You still need environment variables defined in `.env.local` file so run command for example:

```
docker run --env-file ./.env.local -p 3500:3500 hoie/budget
```

Now Budget app should be live [here](http://localhost:3005). Take a look!

## Option 2: Using Node.js

First, download Budget with this command in your terminal. This command will create `budget` folder and download all files in this repository.

```
git clone https://github.com/hoiekim/budget.git
```

Place `.env.local` file in the root of budget directory.

```
mv .env.local ./budget/.env.local
```

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

# How to contribute

Create an [issue](https://github.com/hoiekim/budget/issues/new) and explain how you want to improve this project. Or send us an email to budget@hoie.kim if you feel shy. We welcome your ideas!
