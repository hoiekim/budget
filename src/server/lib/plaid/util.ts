import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { MaskedUser } from "server";

const { PLAID_CLIENT_ID, PLAID_SECRET_PRODUCTION, PLAID_SECRET_DEVELOPMENT, PLAID_SECRET_SANDBOX } =
  process.env;

if (
  !PLAID_CLIENT_ID ||
  !(PLAID_SECRET_PRODUCTION || PLAID_SECRET_DEVELOPMENT) ||
  !PLAID_SECRET_SANDBOX
) {
  console.warn("Plaid is not cofigured. Check env vars.");
}

export const getClient = (user?: MaskedUser) => {
  const isDemo = user?.username === "demo";
  const { production, development, sandbox } = PlaidEnvironments;

  let basePath, secret;

  if (isDemo) {
    basePath = sandbox;
    secret = PLAID_SECRET_SANDBOX;
  } else {
    if (PLAID_SECRET_PRODUCTION) {
      basePath = production;
      secret = PLAID_SECRET_PRODUCTION;
    } else {
      basePath = development;
      secret = PLAID_SECRET_DEVELOPMENT;
    }
  }

  const config = new Configuration({
    basePath,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
        "PLAID-SECRET": secret,
      },
    },
  });
  return new PlaidApi(config);
};

export const ignorable_error_codes = new Set(["NO_INVESTMENT_ACCOUNTS"]);
