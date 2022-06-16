# What is Budget?

Budget is a web app that provides features for monitoring your financial acounts and transactions. We aim to develop this project to be a tool for users to understand their money flow and plan easily. We use 3rd party API provided by [Plaid](https://plaid.com/) so you need Plaid account and credentials to setup Budget on your own environment.

# How do I install Budget?

First, download Budget with this command in your terminal. This command will create `budget` folder and download all files in this repository.

```
git clone https://github.com/hoiekim/budget.git
```

Now we need some environment configuration. Copy `.env.example` file and name it `.env.local`. This file contains environment variables and Budget will try to read them once you run it. You need to keep the keys but use your own values depend on your environment. Open your favorite text editor and change values in `.env.local` file. See below for how to determine correct environment variables.

- `ADMIN_PASSWORD` is password that you will use when login to Budget as administrator user. Choose one that you would like.

- `PLAID_CLIENT_ID` is a unique identifier for a Plaid user. Go to [Plaid](https://plaid.com), sign up and get your client id.

- `PLAID_SECRET_DEVELOPMENT` and `PLAID_SECRET_SANDBOX` are kinds of password that you need to request data from Plaid API. Go to [Plaid](https://plaid.com), sign up and get your development and sandbox secret key. If you want to use production secret key, you need to change `configuration.basePath` value in `server/src/lib/plaid.ts` file. Currently it's set to development.

- `ELASTICSEARCH_HOST` is an address to an Elasticsearch server. You can download it from their [official website](https://elastic.co) for free and install it on your local machine. Or consider using free external hosting service, [Learndatabases](https://learndatabases.dev).

Once you setup all environment variables, make sure you have [npm](https://npmjs.com) installed in your machine and available in your terminal. Then use this command to install Budget.

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
