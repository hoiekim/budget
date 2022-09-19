import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { MaskedUser } from "server";

const { PLAID_CLIENT_ID, PLAID_SECRET_DEVELOPMENT, PLAID_SECRET_SANDBOX } = process.env;

if (!PLAID_CLIENT_ID || !PLAID_SECRET_DEVELOPMENT || !PLAID_SECRET_SANDBOX) {
  console.warn("Plaid is not cofigured. Check env vars.");
}

export const getPlaidClient = (user?: MaskedUser) => {
  const isDemo = user?.username === "demo";
  const config = new Configuration({
    basePath: isDemo ? PlaidEnvironments.sandbox : PlaidEnvironments.development,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
        "PLAID-SECRET": isDemo ? PLAID_SECRET_SANDBOX : PLAID_SECRET_DEVELOPMENT,
      },
    },
  });
  return new PlaidApi(config);
};
